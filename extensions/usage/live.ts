import { ModelRuntime, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  lazyApi,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import {
  accountLoginProvider,
  isSubscriptionAccount,
  nativeAccounts,
  type LegacyAccount,
  type NativeAccount,
} from "../../src/account-identity.ts";
import { readAllowance, type AllowanceAdapter, type AllowanceSnapshot } from "./allowances.ts";
import type { AccountInfo } from "./model.ts";

export interface LiveUsageOptions {
  credentials?: CredentialStore;
  modelsPath?: string | null;
  fetcher?: typeof fetch;
  legacy?: LegacyAccount[];
  adapters?: ReadonlyMap<string, AllowanceAdapter>;
}
/** Lazy, command-only credential access; native refresh locking remains Pi-owned. */
export async function loadLiveUsage(
  ctx: ExtensionContext,
  signal: AbortSignal,
  options: LiveUsageOptions = {},
): Promise<{ accounts: AccountInfo[]; snapshots: AllowanceSnapshot[] }> {
  const runtime = await ModelRuntime.create({
    credentials: options.credentials,
    modelsPath: options.modelsPath,
    refreshOnCreate: false,
    signal,
  });
  signal.throwIfAborted();
  const providers = new Map(runtime.getProviders().map((p) => [p.id, p]));
  for (const id of new Set([
    ...ctx.modelRegistry.getAll().map((m) => m.provider),
    ...ctx.modelRegistry.getRegisteredProviderIds(),
  ])) {
    const provider = ctx.modelRegistry.getProvider(id);
    if (provider) providers.set(id, provider);
  }
  const credentials = await runtime.listCredentials({ signal });
  const accounts = nativeAccounts([...providers.values()], credentials, options.legacy).filter(
    (a) => isSubscriptionAccount(a, providers.get(a.provider)),
  );
  // Explicit tool-credit exception. Reuse the registered Web provider when present;
  // standalone mode uses the same native key/env contract without loading Web's tools.
  // It has no models, so it is deliberately outside subscription/model account discovery.
  if (
    credentials.some((c) => c.providerId === "firecrawl" && c.type === "api_key") ||
    process.env.FIRECRAWL_API_KEY?.trim()
  ) {
    providers.set(
      "firecrawl",
      providers.get("firecrawl") ??
        createProvider({
          id: "firecrawl",
          name: "Firecrawl",
          baseUrl: "https://api.firecrawl.dev/v2",
          auth: { apiKey: envApiKeyAuth("Firecrawl API key", ["FIRECRAWL_API_KEY"]) },
          models: [],
          api: lazyApi(async () => {
            throw new Error("Not a model provider");
          }),
        }),
    );
    accounts.push({
      id: "native:firecrawl",
      name: "Team",
      provider: "firecrawl",
      credentialId: "firecrawl",
      type: "api_key",
    });
  }
  const pending: NativeAccount[] = [...accounts];
  const snapshots: AllowanceSnapshot[] = [];
  // Bound concurrency. No polling, billable requests, or automatic reset consumption.
  await Promise.all(
    Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length && !signal.aborted) {
        const account = pending.shift()!;
        const base = providers.get(account.provider)!;
        runtime.registerNativeProvider(
          account.provider === "firecrawl"
            ? base
            : accountLoginProvider(base, account.credentialId, account.name),
        );
        snapshots.push(
          await readAllowance(
            account,
            async () => (await runtime.getAuth(account.credentialId, { signal }))?.auth.apiKey,
            signal,
            options.fetcher,
            options.adapters,
          ),
        );
      }
    }),
  );
  signal.throwIfAborted();
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  return {
    accounts: accounts.map((a) => ({ ...a, enabled: true })),
    snapshots: snapshots.sort((a, b) => order.get(a.account.id)! - order.get(b.account.id)!),
  };
}
