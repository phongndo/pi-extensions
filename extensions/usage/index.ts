import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { UsageLedger, safeLabel } from "./ledger.ts";
import { showDashboard } from "./dashboard.ts";
import { type AccountInfo, type Period } from "./model.ts";
import { loadLiveUsage, type LiveUsageOptions } from "./live.ts";
import type { AllowanceSnapshot } from "./allowances.ts";
import { isSubscriptionProvider } from "../../src/account-identity.ts";

export function createUsageExtension(
  options: LiveUsageOptions & { directory?: string; live?: boolean } = {},
) {
  return (pi: ExtensionAPI) => {
    const ledger = new UsageLedger(options.directory ?? join(getAgentDir(), "usage"));
    let routerAccounts: AccountInfo[] = [];
    let context: ExtensionContext | undefined;
    let failed = false;
    let active = true;
    const lifetime = new AbortController();
    let opening = false;
    const seen = new WeakSet<object>();
    let authMetadata: Promise<ModelRuntime> | undefined;
    const storedAuthType = async (provider: string) => {
      // isUsingOAuth() reads Pi's availability snapshot, not the auth that resolved the request.
      // That snapshot can lag startup/reload/provider registration. Native login metadata is
      // authoritative when present; listCredentials does not resolve or refresh any token.
      authMetadata ??= ModelRuntime.create({
        credentials: options.credentials,
        modelsPath: null,
        refreshOnCreate: false,
        signal: lifetime.signal,
      });
      const runtime = await authMetadata;
      return (await runtime.listCredentials({ signal: lifetime.signal })).find(
        (c) => c.providerId === provider,
      )?.type;
    };
    const append = (value: unknown) => {
      if (
        !active ||
        !value ||
        typeof value !== "object" ||
        !("subscription" in value) ||
        value.subscription !== true
      )
        return;
      try {
        ledger.append(value);
      } catch {
        if (!failed)
          context?.ui.notify(
            "Usage could not be saved. Check permissions/disk space; totals may be incomplete.",
            "warning",
          );
        failed = true;
      }
    };
    const offUsage = pi.events.on("router:usage", append);
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
    });
    pi.on("message_end", async (event, ctx) => {
      const message = event.message;
      if (message.role !== "assistant" || message.stopReason === "pending" || seen.has(message))
        return;
      seen.add(message);
      // Router publishes every attempt (including failed fallbacks), before this final message.
      if (message.provider.startsWith("accounts-")) return;
      const model = ctx.modelRegistry.find(message.provider, message.model);
      if (!model || !isSubscriptionProvider(ctx.modelRegistry.getProvider(message.provider)))
        return;
      let authType: "oauth" | "api_key" | undefined;
      try {
        authType = await storedAuthType(message.provider);
      } catch {
        if (!active) return;
        authMetadata = undefined; // Retry a transient credential-store failure on the next message.
      }
      if (authType ? authType !== "oauth" : !ctx.modelRegistry.isUsingOAuth(model)) return;
      append({
        id: randomUUID(),
        sessionId: ctx.sessionManager.getSessionId(),
        accountId: `native:${message.provider}`,
        accountName:
          routerAccounts.find((a) => a.id === `native:${message.provider}`)?.name ?? "Pi login",
        provider: message.provider,
        model: message.model,
        subscription: true,
        timestamp: message.timestamp,
        usage: message.usage,
        outcome: message.stopReason,
      });
    });
    // Native compaction events do not identify the billed provider/auth method.
    // Do not guess a subscription from the currently selected model. Routed attempts are attributed.
    pi.registerCommand("usage", {
      description:
        "Subscription allowances and Firecrawl credits; recorded history [period] [provider]",
      getArgumentCompletions: (prefix) =>
        ["session", "7d", "30d", "all"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        if (!ctx.hasUI) return;
        if (opening) return;
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const period = ["session", "7d", "30d", "all"].includes(parts[0] ?? "")
          ? parts.shift()!
          : "7d";
        const provider = parts.shift();
        if (parts.length || (provider && !/^[a-zA-Z0-9._-]+$/.test(provider))) {
          ctx.ui.notify("Usage: /usage [session|7d|30d|all] [provider]", "warning");
          return;
        }
        opening = true;
        try {
          pi.events.emit("router:request-accounts", {});
          const { records: saved, skipped } = await ledger.read(AbortSignal.timeout(15_000));
          // Preserve old API history on disk, but this dashboard is subscription-only.
          const records = saved.filter((r) => r.subscription);
          if (skipped || failed)
            ctx.ui.notify(
              `Usage may be incomplete: ${skipped} invalid record(s) skipped${failed ? "; some writes failed" : ""}.`,
              "warning",
            );
          let accounts = [...routerAccounts];
          let snapshots: AllowanceSnapshot[] = [];
          let liveError: string | undefined;
          if (
            options.live !== false &&
            !(process.env.PI_OFFLINE && process.env.PI_OFFLINE !== "0")
          ) {
            try {
              const live = await loadLiveUsage(
                ctx,
                AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]),
                {
                  ...options,
                  legacy: routerAccounts.flatMap((a) =>
                    a.credentialId
                      ? [
                          {
                            id: a.id,
                            name: a.name,
                            provider: a.provider,
                            credentialId: a.credentialId,
                          },
                        ]
                      : [],
                  ),
                },
              );
              accounts = live.accounts;
              snapshots = live.snapshots;
            } catch {
              liveError = "Live limits unavailable; local totals still shown";
            }
          } else liveError = "Live limits disabled/offline";
          if (!active) return;
          const providers = new Set([
            ...records.map((r) => r.provider),
            ...accounts.map((a) => a.provider),
          ]);
          if (provider && !providers.has(provider)) {
            ctx.ui.notify(
              `No recorded usage or stored login for provider ${provider}. Use /usage for overall usage.`,
              "warning",
            );
            return;
          }
          await showDashboard(ctx, records, accounts, period as Period, {
            provider,
            snapshots,
            liveError,
          });
        } catch {
          if (active)
            ctx.ui.notify("Could not read usage history (unreadable files or timeout).", "error");
        } finally {
          opening = false;
        }
      },
    });
    pi.on("session_shutdown", () => {
      active = false;
      lifetime.abort();
      offUsage();
      offAccounts();
      context = undefined;
    });
  };
}
export default createUsageExtension();
