import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeLabel } from "./labels.ts";
import { loadWithUsageUI, showDashboard } from "./dashboard.ts";
import type { AccountInfo } from "./model.ts";
import { loadLiveUsage, type LiveUsageOptions } from "./live.ts";
import type { AllowanceSnapshot } from "./allowances.ts";
import { isSubscriptionProvider } from "../../src/account-identity.ts";
import { UsageFooter } from "./footer.ts";

export function createUsageExtension(options: LiveUsageOptions & { live?: boolean } = {}) {
  return (pi: ExtensionAPI) => {
    let routerAccounts: AccountInfo[] = [];
    let context: ExtensionContext | undefined;
    let active = true;
    const lifetime = new AbortController();
    const liveEnabled = () =>
      options.live !== false && !(process.env.PI_OFFLINE && process.env.PI_OFFLINE !== "0");
    const legacy = () =>
      routerAccounts.flatMap((a) =>
        a.credentialId
          ? [{ id: a.id, name: a.name, provider: a.provider, credentialId: a.credentialId }]
          : [],
      );
    const footer = new UsageFooter(async (ctx, accountId, signal) => {
      const loaded = await loadLiveUsage(ctx, signal, { ...options, legacy: legacy(), accountId });
      return loaded.snapshots.find((s) => s.account.id === accountId);
    }, liveEnabled);
    let routedAccount: { id: string; provider: string } | undefined;
    const updateFooter = (ctx: ExtensionContext, force = false) => {
      context = ctx;
      const model = ctx.model;
      const accountId = model?.provider.startsWith("accounts-")
        ? routedAccount?.provider === model.provider.slice("accounts-".length)
          ? routedAccount.id
          : undefined
        : model &&
            isSubscriptionProvider(ctx.modelRegistry.getProvider(model.provider)) &&
            ctx.modelRegistry.isUsingOAuth(model)
          ? `native:${model.provider}`
          : undefined;
      footer.update(ctx, accountId, force);
    };
    const offActive = pi.events.on("router:active-account", (value: unknown) => {
      const previous = routedAccount;
      routedAccount =
        value &&
        typeof value === "object" &&
        "id" in value &&
        typeof value.id === "string" &&
        "provider" in value &&
        typeof value.provider === "string"
          ? { id: value.id, provider: value.provider }
          : undefined;
      if (
        context &&
        active &&
        (previous?.id !== routedAccount?.id || previous?.provider !== routedAccount?.provider)
      )
        updateFooter(context);
    });
    let opening = false;
    const offAccounts = pi.events.on("router:accounts", (value: unknown) => {
      if (!Array.isArray(value)) return;
      routerAccounts = value
        .filter(
          (a): a is AccountInfo =>
            !!a &&
            typeof a.id === "string" &&
            typeof a.name === "string" &&
            typeof a.provider === "string" &&
            typeof a.enabled === "boolean" &&
            a.type === "oauth" &&
            isSubscriptionProvider(context?.modelRegistry.getProvider(a.provider)),
        )
        .map((a) => ({
          id: a.id,
          name: safeLabel(a.name),
          provider: safeLabel(a.provider),
          enabled: a.enabled,
          credentialId: typeof a.credentialId === "string" ? a.credentialId : undefined,
        }));
    });
    pi.on("session_start", (_event, ctx) => {
      context = ctx;
      pi.events.emit("router:request-accounts", {});
      updateFooter(ctx);
    });
    pi.on("model_select", (_event, ctx) => updateFooter(ctx));
    pi.on("session_tree", (_event, ctx) => {
      routedAccount = undefined;
      updateFooter(ctx);
      pi.events.emit("router:request-accounts", {});
    });
    pi.on("input", (_event, ctx) => {
      updateFooter(ctx);
      return { action: "continue" };
    });
    pi.on("agent_end", (_event, ctx) => updateFooter(ctx, true));
    pi.registerCommand("usage", {
      description: "Subscription allowances and Firecrawl credits [provider]",
      handler: async (args, ctx) => {
        if (!ctx.hasUI || opening) return;
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const provider = parts.shift();
        if (parts.length || (provider && !/^[a-zA-Z0-9._-]+$/.test(provider))) {
          ctx.ui.notify("Usage: /usage [provider]", "warning");
          return;
        }
        opening = true;
        try {
          pi.events.emit("router:request-accounts", {});
          const loaded = await loadWithUsageUI(ctx, lifetime.signal, async (signal) => {
            let accounts = [...routerAccounts];
            let snapshots: AllowanceSnapshot[] = [];
            let liveError: string | undefined;
            if (liveEnabled()) {
              try {
                const live = await loadLiveUsage(
                  ctx,
                  AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
                  { ...options, legacy: legacy() },
                );
                accounts = live.accounts;
                snapshots = live.snapshots;
              } catch {
                liveError = "Live limits unavailable";
              }
            } else liveError = "Live limits disabled/offline";
            return { accounts, snapshots, liveError };
          });
          if (!active || !loaded) return;
          const { accounts, snapshots, liveError } = loaded;
          footer.accept(snapshots);
          const providers = new Set([
            ...accounts.map((a) => a.provider),
            ...snapshots.map((s) => s.account.provider),
          ]);
          if (provider && !providers.has(provider)) {
            ctx.ui.notify(
              `No stored login or allowance status for provider ${provider}. Use /usage for overall usage.`,
              "warning",
            );
            return;
          }
          await showDashboard(ctx, accounts, { provider, snapshots, liveError });
        } catch {
          if (active) ctx.ui.notify("Could not load usage allowances.", "error");
        } finally {
          opening = false;
        }
      },
    });
    pi.on("session_shutdown", () => {
      active = false;
      lifetime.abort();
      offAccounts();
      offActive();
      footer.close();
      context = undefined;
    });
  };
}
export default createUsageExtension();
