import { expect, test } from "bun:test";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadLiveUsage } from "../live.ts";

test("standalone Firecrawl uses native stored-key precedence, then environment; subscriptions need no allowance adapter to appear", async () => {
  const originalEnv = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = "fake-env-key";
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("firecrawl", async () => ({
      type: "api_key",
      key: "fake-stored-key",
    }));
    for (const id of ["xai", "future-subscription", "not-subscription"])
      await credentials.modify(id, async () => ({
        type: "oauth",
        access: "expired",
        refresh: "do-not-refresh",
        expires: 0,
      }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const xai = runtime.getProvider("xai")!;
    const refreshed: string[] = [];
    for (const id of ["xai", "future-subscription", "not-subscription"]) {
      const provider: Provider = {
        ...xai,
        id,
        auth: {
          oauth: {
            ...xai.auth.oauth!,
            isSubscription: id !== "not-subscription",
            refresh: async (credential) => {
              refreshed.push(id);
              return { ...credential, access: "fake-grok-token", expires: Date.now() + 3600000 };
            },
          },
        },
        getModels: () =>
          xai
            .getModels()
            .slice(0, 1)
            .map((m) => ({ ...m, provider: id })),
      };
      runtime.registerNativeProvider(provider);
    }
    const ctx = { modelRegistry: new ModelRegistry(runtime) } as ExtensionContext;
    const headers: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      if (url === "https://cli-chat-proxy.grok.com/v1/billing?format=credits") {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          "Bearer fake-grok-token",
        );
        return Response.json({ config: { creditUsagePercent: 25 } });
      }
      expect(url).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
      headers.push((init.headers as Record<string, string>).Authorization!);
      return Response.json({ success: true, data: { remainingCredits: 500 } });
    }) as typeof fetch;
    const options = { credentials, modelsPath: null, fetcher };
    const a = await loadLiveUsage(ctx, new AbortController().signal, options);
    expect(a.accounts.map((a) => a.provider).sort()).toEqual([
      "firecrawl",
      "future-subscription",
      "xai",
    ]);
    expect(
      a.snapshots.find((s) => s.account.provider === "firecrawl")?.allowances[0]?.remaining,
    ).toBe(500);
    expect(
      a.snapshots.find((s) => s.account.provider === "future-subscription")?.unavailable,
    ).toContain("not supported");
    expect(
      a.snapshots.find((s) => s.account.provider === "xai")?.allowances[0]?.remainingPercent,
    ).toBe(75);
    expect(refreshed).toEqual(["xai"]);
    expect(JSON.stringify(a)).not.toContain("fake-grok-token");
    expect(headers).toEqual(["Bearer fake-stored-key"]);
    expect(JSON.stringify(a)).not.toContain("fake-stored-key");
    await credentials.delete("firecrawl");
    const b = await loadLiveUsage(ctx, new AbortController().signal, options);
    expect(b.accounts.find((a) => a.provider === "firecrawl")?.name).toBe("Team");
    expect(headers).toEqual(["Bearer fake-stored-key", "Bearer fake-env-key"]);
    delete process.env.FIRECRAWL_API_KEY;
    const c = await loadLiveUsage(ctx, new AbortController().signal, options);
    expect(c.accounts.some((a) => a.provider === "firecrawl")).toBe(false);
    expect(headers).toHaveLength(2);
  } finally {
    if (originalEnv === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = originalEnv;
  }
});
