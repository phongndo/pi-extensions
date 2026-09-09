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
  nativeAccounts,
  isSubscriptionAccount,
  poolId,
  POOL_PREFIX,
  sourceProvider,
  type NativeAccount,
} from "../../src/account-identity.ts";
import { AccountRouter } from "./router.ts";
import {
  RankingStore,
  multipleAccounts,
  rankAccounts,
  readLegacyAccounts,
  type Rankings,
} from "./store.ts";
import { MASKED_EMAIL, promptAlias, showRankings } from "./ui.ts";
import { credentialEmail } from "./identity.ts";
import { installNativeLogin } from "./native-login.ts";

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
    let closed = false;
    let selecting = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let syncing: Promise<void> | undefined;
    let removeNativeLogin: (() => void) | undefined;
    const lookup = (id: string) => ctx?.modelRegistry.getProvider(id) ?? baseline.get(id);
    const sources = () =>
      [
        ...new Set([
          ...baseline.keys(),
          ...(ctx?.modelRegistry.getAll().map((m) => m.provider) ?? []),
          ...(ctx?.modelRegistry.getRegisteredProviderIds() ?? []),
        ]),
      ]
        .filter((id) => !id.startsWith("account-") && !id.startsWith(POOL_PREFIX))
        .map(lookup)
        .filter((p): p is Provider => !!p && p.getModels().length > 0);
    const readAccounts = async () => {
      const credentials = await runtime.listCredentials();
      const { order, aliases } = store.readMetadata();
      savedAccounts = rankAccounts(
        nativeAccounts(sources(), credentials, readLegacyAccounts(options.legacyPath)),
        order,
        aliases,
      );
      return savedAccounts.filter((a) => isSubscriptionAccount(a, lookup(a.provider)));
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
      lookup,
      {
        attempt: (attempt) => {
          if (ctx && !closed)
            pi.events.emit("router:usage", {
              ...attempt,
              sessionId: ctx.sessionManager.getSessionId(),
            });
        },
      },
    );
    const registered = new Map<string, { base: Provider; name: string }>();
    const publish = () =>
      pi.events.emit(
        "router:accounts",
        accounts.map((a) => ({ ...a, name: a.alias ?? a.name, enabled: true })),
      );
    async function synchronize() {
      accounts = await readAccounts();
      if (closed) return;
      const desired = new Set<string>();
      const add = (provider: Provider, base: Provider) => {
        desired.add(provider.id);
        const previous = registered.get(provider.id);
        if (previous?.base === base && previous.name === provider.name) return;
        pi.registerProvider(provider);
        registered.set(provider.id, { base, name: provider.name });
      };
      for (const base of sources()) {
        // Retain old non-subscription slots for native /logout, but never route them.
        for (const a of savedAccounts.filter((a) => a.provider === base.id))
          if (a.credentialId !== base.id)
            add(accountLoginProvider(base, a.credentialId, a.alias ?? a.name), base);
        const group = accounts.filter((a) => a.provider === base.id);
        // Only extra native login entries need a routed model. Single ordinary logins stay untouched.
        if (group.some((a) => a.credentialId !== base.id)) add(router.provider(base.id)!, base);
      }
      // Keep a selected route as a fail-closed tombstone if its last login was removed mid-session.
      if (ctx?.model?.provider.startsWith(POOL_PREFIX)) desired.add(ctx.model.provider);
      for (const id of registered.keys())
        if (!desired.has(id)) {
          pi.unregisterProvider(id);
          registered.delete(id);
        }
      publish();
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
        await selectRoute(context);
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
    async function selectRoute(context: ExtensionContext) {
      if (closed || selecting || !context.model) return;
      const original = sourceProvider(context.model.provider);
      const group = accounts.filter((a) => a.provider === original);
      const id = group.some((a) => a.credentialId !== original) ? poolId(original) : original;
      if (id === context.model.provider) return;
      const model = context.modelRegistry.find(id, context.model.id);
      if (!model) return;
      selecting = true;
      try {
        await pi.setModel(model);
      } finally {
        selecting = false;
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
          if (ctx && !closed) await selectRoute(ctx);
        },
      });
      await selectRoute(context);
      if (!closed && !poll) {
        // Pi exposes no login/logout event. Observe credential metadata only; never refresh OAuth here.
        poll = setInterval(() => {
          if (!ctx?.isIdle() || closed || syncing) return;
          void refresh()
            .then(() => (ctx && ctx.isIdle() ? selectRoute(ctx) : undefined))
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
      if (!selecting) await refreshForInput(context);
    });
    pi.registerCommand("router", {
      description: "Rank subscription accounts by provider; /router alias labels a subscription",
      getArgumentCompletions: (prefix) =>
        "alias".startsWith(prefix)
          ? [{ value: "alias", label: "alias", description: "Name an individual account" }]
          : null,
      handler: async (args, context) => {
        if (!context.hasUI) return;
        const aliasOnly = args.trim() === "alias";
        if (args.trim() && !aliasOnly) {
          context.ui.notify(
            "/router ranks accounts; /router alias names them. Use /login and /logout to manage them.",
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
          const initial = multipleAccounts(accounts);
          if (!initial.length) {
            context.ui.notify(
              "No providers with two signed-in subscriptions. Add subscriptions with /login; name them with /router alias.",
              "info",
            );
            return;
          }
          const expected = store.read();
          const emails = await readEmails(initial);
          const result = await showRankings(context, initial, names, emails);
          if (!result || closed) return;
          const current = await readAccounts();
          const changes: Rankings = {};
          for (const provider of new Set(initial.map((a) => a.provider))) {
            const before = initial.filter((a) => a.provider === provider).map((a) => a.id);
            const after = result.filter((a) => a.provider === provider).map((a) => a.id);
            const live = current.filter((a) => a.provider === provider).map((a) => a.id);
            if (before.length !== live.length || live.some((id) => !before.includes(id)))
              throw new Error("Logins changed. Reopen /router.");
            if (JSON.stringify(before) !== JSON.stringify(after)) changes[provider] = after;
          }
          const aliasChanges: Record<string, string | undefined> = {};
          const expectedAliases: Record<string, string> = {};
          for (const account of initial) {
            const updated = result.find((a) => a.id === account.id);
            if (!updated) throw new Error("Logins changed");
            if (updated.alias !== account.alias) aliasChanges[account.id] = updated.alias;
            if (account.alias !== undefined) expectedAliases[account.id] = account.alias;
          }
          store.save(changes, expected, aliasChanges, expectedAliases);
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
