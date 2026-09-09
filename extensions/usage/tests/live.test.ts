import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { loadLiveUsage } from "../live.ts";
import { loginId } from "../../../src/account-identity.ts";
let firecrawlEnv: string | undefined;
beforeEach(() => {
  firecrawlEnv = process.env.FIRECRAWL_API_KEY;
  delete process.env.FIRECRAWL_API_KEY;
});
afterEach(() => {
  if (firecrawlEnv === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = firecrawlEnv;
});
const token = (id: string) =>
  `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.s`;
test("standalone live usage discovers native aliases and uses Pi's per-account locked OAuth refresh", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "expired",
    refresh: "first",
    expires: 0,
  }));
  await credentials.modify(loginId("openai-codex", 2), async () => ({
    type: "oauth",
    access: "expired",
    refresh: "second",
    expires: 0,
  }));
  await credentials.modify("anthropic", async () => ({ type: "api_key", key: "do-not-resolve" }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const original = runtime.getProvider("openai-codex")!;
  let refreshed = 0;
  const base: Provider = {
    ...original,
    auth: {
      oauth: {
        ...original.auth.oauth!,
        refresh: async (c) => {
          refreshed++;
          return { ...c, access: token(c.refresh), expires: Date.now() + 3600000 };
        },
      },
    },
  };
  runtime.registerNativeProvider(base);
  const ctx = { modelRegistry: new ModelRegistry(runtime) } as ExtensionContext;
  const requested: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    requested.push((init.headers as Record<string, string>)["ChatGPT-Account-Id"]!);
    return Response.json(
      url.endsWith("/usage")
        ? { plan_type: "pro", rate_limit: null }
        : { available_count: 0, credits: [] },
    );
  }) as typeof fetch;
  const options = { credentials, modelsPath: null, fetcher };
  const [a, b] = await Promise.all([
    loadLiveUsage(ctx, new AbortController().signal, options),
    loadLiveUsage(ctx, new AbortController().signal, options),
  ]);
  expect(refreshed).toBe(2); // not four, despite concurrent dashboards
  expect(requested.sort()).toEqual([...Array(4).fill("first"), ...Array(4).fill("second")]);
  expect(a.snapshots).toHaveLength(2);
  expect(b.snapshots).toHaveLength(2);
  expect(a.accounts.map((a) => a.provider)).toEqual(["openai-codex", "openai-codex"]);
  expect(JSON.stringify(a)).not.toContain("expired");
  expect((await credentials.read(loginId("openai-codex", 2)))?.type).toBe("oauth");
});
