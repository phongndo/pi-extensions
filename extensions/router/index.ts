import { dirname, join } from "node:path";
import {
  getAgentDir,
  readStoredCredential,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  accountLoginProvider,
  accountRouteProvider,
  nativeAccounts,
  isSubscriptionAccount,
  POOL_PREFIX,
  sourceProvider,
  type NativeAccount,
} from "../../src/account-identity.ts";
import { AccountRouter } from "./router.ts";
import { setFooterStatus } from "../../src/footer-status.ts";
import { RankingStore, rankAccounts, readLegacyAccounts, type Rankings } from "./store.ts";
import { MASKED_EMAIL, promptAlias, showRankings } from "./ui.ts";
import { credentialEmail } from "./identity.ts";
import { installNativeLogin } from "./native-login.ts";
import { SESSION_ACCOUNT_ENTRY, sessionAccounts } from "./session.ts";
import {
  DIAGNOSTIC_ENTRY,
  DIAGNOSTIC_LIMIT,
  formatDiagnostics,
  sessionDiagnostics,
  type RouterDiagnostic,
} from "./diagnostics.ts";

export interface RouterExtensionOptions {
  configPath?: string;
  legacyPath?: string;
  credentials?: CredentialStore;
  providers?: Provider[];
  modelsPath?: string | null;
  pollMs?: number;
}
export function createRouterExtension(options: RouterExtensionOptions = {}) {
  return async (pi: ExtensionAPI) => {
    const store = new RankingStore(options.configPath);
    const runtime = await ModelRuntime.create({
      refreshOnCreate: false,
      credentials: options.credentials,
      modelsPath: options.modelsPath,
    });
    const baseline = new Map((options.providers ?? runtime.getProviders()).map((p) => [p.id, p]));
    let ctx: ExtensionContext | undefined;
    let accounts: NativeAccount[] = [];
    let savedAccounts: NativeAccount[] = [];
    let preferences = new Map<string, string>();
    let diagnostics: RouterDiagnostic[] = [];
    let closed = false;
    let selecting = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let syncing: Promise<void> | undefined;
    let removeNativeLogin: (() => void) | undefined;
    const registered = new Map<string, { base: Provider; name: string }>();
    // Providers registered on the extension-local runtime the router streams through. Pi's
    // registry and that runtime are separate instances; a streamed id must exist on both.
    const localSlots = new Map<string, { base: Provider; name: string }>();
    // The registry may hold our own in-place override; always resolve the untouched
    // provider for account discovery, wrapper construction, and stream delegation.
    const original = (id: string) =>
      registered.get(id)?.base ?? baseline.get(id) ?? ctx?.modelRegistry.getProvider(id);
    const sources = () =>
      [
        ...new Set([
          ...baseline.keys(),
          ...(ctx?.modelRegistry.getAll().map((m) => m.provider) ?? []),
          ...(ctx?.modelRegistry.getRegisteredProviderIds() ?? []),
        ]),
      ]
        .filter((id) => !id.startsWith("account-") && !id.startsWith(POOL_PREFIX))
        .map(original)
        .filter((p): p is Provider => !!p && p.getModels().length > 0);
    const readAccounts = async () => {
      const credentials = await runtime.listCredentials();
      const { order, aliases } = store.readMetadata();
      savedAccounts = rankAccounts(
        nativeAccounts(sources(), credentials, readLegacyAccounts(options.legacyPath)),
        order,
        aliases,
      );
      return savedAccounts.filter((a) => isSubscriptionAccount(a, original(a.provider)));
    };
    // Display-only and command-scoped: never publish emails or put them in ranking metadata.
    const readEmails = async (group: NativeAccount[]) => {
      const emails = new Map<string, string>();
      await Promise.all(
        group.map(async (a) => {
          try {
            const credential = await (options.credentials
              ? options.credentials.read(a.credentialId)
              : readStoredCredential(a.credentialId));
            const email = credential && credentialEmail(credential);
            if (email) emails.set(a.id, email);
          } catch {
            /* An unavailable email must not prevent ranking an account. */
          }
        }),
      );
      return emails;
    };
    const router = new AccountRouter(
      runtime,
      async (id) => (options.credentials ? options.credentials.read(id) : readStoredCredential(id)),
      readAccounts,
      original,
      {
        preferred: (provider) => preferences.get(provider),
        selected: () => updateFooter(),
        failed: (diagnostic) => {
          if (!ctx || closed) return;
          diagnostics.push(diagnostic);
          if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
          // Keep an in-memory copy even if session persistence fails. Custom entries are
          // durable across reload/resume but never enter LLM context or Pi's retry logic.
          pi.appendEntry(DIAGNOSTIC_ENTRY, diagnostic);
        },
        attempt: (attempt) => {
          if (ctx && !closed)
            pi.events.emit("router:usage", {
              ...attempt,
              sessionId: ctx.sessionManager.getSessionId(),
            });
        },
      },
    );
    function updateFooter() {
      if (!ctx || closed) return;
      const provider = ctx.model?.provider;
      const source = provider && sourceProvider(provider);
      const group = provider ? accounts.filter((a) => a.provider === source) : [];
      const healthy = (a: NativeAccount) => (router.health.get(a.id)?.until ?? 0) <= Date.now();
      const account =
        group.find((a) => a.id === router.active.get(source!)) ??
        group.find((a) => a.id === preferences.get(source!) && healthy(a)) ??
        group.find(healthy);
      pi.events.emit(
        "router:active-account",
        account ? { id: account.id, provider: account.provider } : undefined,
      );
      setFooterStatus(
        ctx,
        "router",
        account && group.length >= 2 ? `route ${account.alias ?? account.name}` : undefined,
      );
    }
    // Provider ids currently routing through the pool. Consumers (e.g. Fast mode) must not
    // re-derive this from account counts or id prefixes: a sole remaining slot still routes.
    let routes: string[] = [];
    const publish = () => {
      pi.events.emit(
        "router:accounts",
        accounts.map((a) => ({ ...a, name: a.alias ?? a.name, enabled: true })),
      );
      pi.events.emit("router:routes", routes);
    };
    async function synchronize() {
      accounts = await readAccounts();
      if (closed) return;
      const desiredApp = new Set<string>();
      const desiredLocal = new Set<string>();
      const routed: string[] = [];
      const addApp = (provider: Provider, base: Provider) => {
        desiredApp.add(provider.id);
        const previous = registered.get(provider.id);
        if (previous?.base === base && previous.name === provider.name) return;
        pi.registerProvider(provider);
        registered.set(provider.id, { base, name: provider.name });
      };
      // The router streams each attempt through its own ModelRuntime (for per-account transport
      // isolation), which Pi never sees. Anything it may stream must be registered there too, or
      // prepareRequest throws `Unknown provider`.
      const addLocal = (provider: Provider, base: Provider) => {
        desiredLocal.add(provider.id);
        const previous = localSlots.get(provider.id);
        if (previous?.base === base && previous.name === provider.name) return;
        runtime.registerNativeProvider(provider);
        localSlots.set(provider.id, { base, name: provider.name });
      };
      for (const base of sources()) {
        const group = accounts.filter((a) => a.provider === base.id);
        // One ordinary login stays native; any extra subscription login makes the provider route itself.
        const routedHere = group.some((a) => a.credentialId !== base.id);
        for (const a of savedAccounts.filter((a) => a.provider === base.id)) {
          if (a.credentialId === base.id) continue;
          // Subscription slots are route targets; other slots stay on Pi's registry only so
          // native /logout can remove them and are never streamed.
          if (isSubscriptionAccount(a, base)) {
            const slot = accountRouteProvider(base, a.credentialId, a.alias ?? a.name);
            addApp(slot, base);
            addLocal(slot, base);
          } else {
            addApp(accountLoginProvider(base, a.credentialId, a.alias ?? a.name), base);
          }
        }
        if (routedHere) {
          // Pi's public route: the source provider with a stream that picks the account.
          addApp(router.provider(base.id)!, base);
          // The router streams the native login from its own runtime too. Use an OAuth-only slot
          // delegating to the pristine provider, never the public route, which would recurse.
          addLocal(accountRouteProvider(base, base.id, base.name), base);
          routed.push(base.id);
        }
      }
      // Resume tombstone: keep a previously selected legacy `accounts-<provider>` route resolvable
      // until the session migrates to the transparent base id (see migrateLegacyRoute).
      const legacy = ctx?.model?.provider;
      if (legacy?.startsWith(POOL_PREFIX)) {
        const base = original(sourceProvider(legacy));
        const wrapped = base && router.provider(base.id);
        if (base && wrapped) {
          addApp({ ...wrapped, id: legacy, name: `${base.name} · Accounts` }, base);
          routed.push(legacy);
        }
      }
      routes = routed;
      for (const id of registered.keys())
        if (!desiredApp.has(id)) {
          pi.unregisterProvider(id);
          registered.delete(id);
        }
      for (const id of localSlots.keys())
        if (!desiredLocal.has(id)) {
          runtime.unregisterProvider(id);
          localSlots.delete(id);
        }
      publish();
      updateFooter();
    }
    function refresh(): Promise<void> {
      if (closed) return Promise.resolve();
      // Each caller needs a read started after its mutation, not an older in-flight snapshot.
      // Serialize refreshes so stale completions cannot overwrite newer account metadata.
      const previous = syncing;
      const next = (async () => {
        await previous?.catch(() => {});
        if (!closed) await synchronize();
      })();
      syncing = next;
      return next.finally(() => {
        if (syncing === next) syncing = undefined;
      });
    }
    let refreshFailed = false;
    async function refreshForInput(context: ExtensionContext) {
      try {
        await refresh();
        await migrateLegacyRoute(context);
        refreshFailed = false;
      } catch {
        // Leave selected routes fail-closed; their request-time read still rejects bad metadata.
        // Do not leak filesystem errors into every prompt or keep repeating a warning.
        if (!refreshFailed && !closed)
          context.ui.notify(
            "Router metadata unavailable. Check router.json and native logins; routing resumes after repair.",
            "warning",
          );
        refreshFailed = true;
      }
    }
    async function migrateLegacyRoute(context: ExtensionContext) {
      if (closed || selecting || !context.model) return;
      const current = context.model.provider;
      if (!current.startsWith(POOL_PREFIX)) return;
      const model = context.modelRegistry.find(sourceProvider(current), context.model.id);
      if (!model) return;
      selecting = true;
      try {
        await pi.setModel(model);
      } finally {
        selecting = false;
        updateFooter();
      }
    }
    // Initial registration makes saved routes and account logins visible before Pi restores models.
    await refresh();
    const unsubscribe = pi.events.on("router:request-accounts", () => {
      void refresh()
        .then(publish)
        .catch(() => {});
    });
    pi.on("session_start", async (_event, context) => {
      ctx = context;
      preferences = sessionAccounts(context.sessionManager.getBranch());
      diagnostics = sessionDiagnostics(context.sessionManager.getBranch());
      await refresh();
      removeNativeLogin?.();
      removeNativeLogin = installNativeLogin(context, {
        accounts: () => accounts,
        lockPath: join(
          options.configPath ? dirname(options.configPath) : getAgentDir(),
          "router-login",
        ),
        changed: async (removedCredentialId) => {
          const removed = accounts.find((a) => a.credentialId === removedCredentialId);
          if (removed) {
            const aliases = store.readAliases();
            if (aliases[removed.id] !== undefined)
              store.save({}, {}, { [removed.id]: undefined }, aliases);
          }
          await refresh();
          if (ctx && !closed) await migrateLegacyRoute(ctx);
        },
      });
      await migrateLegacyRoute(context);
      if (!closed && !poll) {
        // Pi exposes no login/logout event. Observe credential metadata only; never refresh OAuth here.
        poll = setInterval(() => {
          if (!ctx?.isIdle() || closed || syncing) return;
          void refresh()
            .then(() => (ctx && ctx.isIdle() ? migrateLegacyRoute(ctx) : undefined))
            .catch(() => {});
        }, options.pollMs ?? 1000);
        poll.unref?.();
      }
    });
    pi.on("input", async (_event, context) => {
      if (context.isIdle()) await refreshForInput(context);
      return { action: "continue" };
    });
    pi.on("model_select", async (_event, context) => {
      ctx = context;
      updateFooter();
      if (!selecting) await refreshForInput(context);
    });
    pi.on("session_tree", async (_event, context) => {
      ctx = context;
      preferences = sessionAccounts(context.sessionManager.getBranch());
      diagnostics = sessionDiagnostics(context.sessionManager.getBranch());
      router.active.clear();
      await refreshForInput(context);
    });
    pi.registerCommand("router", {
      description:
        "Choose/rank accounts; /router alias labels them; /router errors shows upstream failures",
      getArgumentCompletions: (prefix) => {
        const items = [
          {
            value: "account",
            label: "account",
            description: "Choose this session's preferred account",
          },
          { value: "alias", label: "alias", description: "Name an individual account" },
          {
            value: "errors",
            label: "errors",
            description: "Inspect sanitized upstream failures for this session",
          },
        ].filter((item) => item.value.startsWith(prefix));
        return items.length ? items : null;
      },
      handler: async (args, context) => {
        if (!context.hasUI) return;
        // Inspection is read-only and must work even while busy or router.json is broken.
        if (args.trim() === "errors") {
          context.ui.notify(formatDiagnostics(diagnostics), "info");
          return;
        }
        const aliasOnly = args.trim() === "alias";
        const sessionOnly = args.trim() === "account";
        if (args.trim() && !aliasOnly && !sessionOnly) {
          context.ui.notify(
            "/router ranks accounts; /router account selects for this session; /router alias names them; /router errors shows upstream failures. Use /login and /logout to manage them.",
            "info",
          );
          return;
        }
        if (!context.isIdle()) {
          context.ui.notify("Stop the current response before changing priority.", "warning");
          return;
        }
        try {
          await refresh();
          const names = new Map(sources().map((p) => [p.id, p.name]));
          if (sessionOnly) {
            const provider = context.model && sourceProvider(context.model.provider);
            if (!provider) {
              context.ui.notify("Select a model first.", "info");
              return;
            }
            const group = accounts.filter((a) => a.provider === provider);
            if (!group.length && !preferences.has(provider)) {
              context.ui.notify(
                "No signed-in subscriptions for this provider. Use /login.",
                "info",
              );
              return;
            }
            const current = preferences.get(provider);
            const labels = [
              `Automatic · use global rankings${current ? "" : " ✓"}`,
              ...group.map(
                (a, i) => `${i + 1}. ${a.alias ?? a.name}${a.id === current ? " ✓" : ""}`,
              ),
            ];
            const choice = await context.ui.select(
              `Session account · ${names.get(provider) ?? provider} (fallback allowed)`,
              labels,
            );
            const index = choice === undefined ? -1 : labels.indexOf(choice);
            if (index < 0 || closed) return;
            if (!context.isIdle()) {
              context.ui.notify("Stop the current response before changing accounts.", "warning");
              return;
            }
            const account = index === 0 ? undefined : group[index - 1];
            if (account && !(await readAccounts()).some((a) => a.id === account.id))
              throw new Error("Logins changed");
            pi.appendEntry(SESSION_ACCOUNT_ENTRY, { provider, accountId: account?.id ?? null });
            if (account) preferences.set(provider, account.id);
            else preferences.delete(provider);
            router.active.delete(provider);
            await refresh();
            await migrateLegacyRoute(context);
            context.ui.notify(
              account
                ? "Session account saved; usage-limit fallback remains enabled."
                : "Session uses global rankings again.",
              "info",
            );
            return;
          }
          if (aliasOnly) {
            const initial = [...accounts];
            if (!initial.length) {
              context.ui.notify(
                "No signed-in subscriptions. Add subscriptions with /login.",
                "info",
              );
              return;
            }
            const emails = await readEmails(initial);
            const labels = initial.map(
              (a, i) =>
                `${i + 1}. ${names.get(a.provider) ?? a.provider} · ${a.alias ?? ""}  ${emails.has(a.id) ? MASKED_EMAIL : ""}`,
            );
            const choice = await context.ui.select("Alias an account", labels);
            const account = choice === undefined ? undefined : initial[labels.indexOf(choice)];
            if (!account || closed) return;
            const updated = await promptAlias(
              context,
              account,
              names.get(account.provider) ?? account.provider,
            );
            if (closed || updated.alias === account.alias) return;
            if (!(await readAccounts()).some((a) => a.id === account.id))
              throw new Error("Logins changed");
            store.save(
              {},
              {},
              { [account.id]: updated.alias },
              account.alias === undefined ? {} : { [account.id]: account.alias },
            );
            await refresh();
            context.ui.notify(
              updated.alias ? "Account alias saved." : "Account alias cleared.",
              "info",
            );
            return;
          }
          const provider = context.model && sourceProvider(context.model.provider);
          const counts = new Map<string, number>();
          for (const account of accounts)
            counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
          const initial = accounts.filter(
            (a) => a.provider === provider || counts.get(a.provider)! > 1,
          );
          if (!initial.length) {
            context.ui.notify(
              "No signed-in subscriptions. Add subscriptions with /login; name them with /router alias.",
              "info",
            );
            return;
          }
          const expected = store.read();
          const emails = await readEmails(initial);
          // Freeze each provider's default independently of pending fallback reordering.
          const defaults = [...new Set(initial.map((a) => a.provider))].map((provider) => {
            const group = initial.filter((a) => a.provider === provider);
            const account =
              group.find((a) => a.id === preferences.get(provider)) ??
              group.find((a) => a.id === router.active.get(provider)) ??
              group[0]!;
            return { provider, accountId: account.id };
          });
          const result = await showRankings(context, initial, names, emails, defaults);
          if (!result || closed) return;
          if (!context.isIdle()) throw new Error("Session became busy");
          const current = await readAccounts();
          for (const selected of result.sessionDefaults)
            if (
              !current.some((a) => a.provider === selected.provider && a.id === selected.accountId)
            )
              throw new Error("Logins changed");
          const changes: Rankings = {};
          for (const provider of new Set(initial.map((a) => a.provider))) {
            const before = initial.filter((a) => a.provider === provider).map((a) => a.id);
            const after = result.accounts.filter((a) => a.provider === provider).map((a) => a.id);
            const live = current.filter((a) => a.provider === provider).map((a) => a.id);
            if (before.length !== live.length || live.some((id) => !before.includes(id)))
              throw new Error("Logins changed. Reopen /router.");
            if (JSON.stringify(before) !== JSON.stringify(after)) changes[provider] = after;
          }
          const aliasChanges: Record<string, string | undefined> = {};
          const expectedAliases: Record<string, string> = {};
          for (const account of initial) {
            const updated = result.accounts.find((a) => a.id === account.id);
            if (!updated) throw new Error("Logins changed");
            if (updated.alias !== account.alias) aliasChanges[account.id] = updated.alias;
            if (account.alias !== undefined) expectedAliases[account.id] = account.alias;
          }
          store.save(changes, expected, aliasChanges, expectedAliases);
          for (const selected of result.sessionDefaults) {
            if (preferences.get(selected.provider) === selected.accountId) continue;
            pi.appendEntry(SESSION_ACCOUNT_ENTRY, selected);
            preferences.set(selected.provider, selected.accountId);
            router.active.delete(selected.provider);
          }
          await refresh();
        } catch {
          context.ui.notify(
            "Could not save router changes. Logins, rankings or aliases may have changed; reopen /router and check router.json if it persists.",
            "error",
          );
        }
      },
    });
    pi.on("session_shutdown", () => {
      pi.events.emit("router:active-account", undefined);
      if (ctx) setFooterStatus(ctx, "router", undefined);
      closed = true;
      if (poll) clearInterval(poll);
      poll = undefined;
      unsubscribe();
      removeNativeLogin?.();
      removeNativeLogin = undefined;
      router.close();
      ctx = undefined;
    });
  };
}
export default createRouterExtension();
