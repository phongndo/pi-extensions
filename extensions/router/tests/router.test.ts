import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  createModels,
  InMemoryCredentialStore,
  isRetryableAssistantError,
  isContextOverflow,
  registerSessionResourceCleanup,
  type AssistantMessage,
  type Model,
  type Api,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AccountRouter, limitReason, retryAt, type AttemptUsage } from "../router.ts";
import {
  accountRouteProvider,
  type NativeAccount as Account,
} from "../../../src/account-identity.ts";

const model: Model<Api> = {
  id: "test-model",
  name: "Test",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
function message(error?: string, partial = false): AssistantMessage {
  return {
    role: "assistant",
    provider: "test",
    model: model.id,
    api: model.api,
    timestamp: 1,
    content: partial ? [{ type: "text", text: "partial" }] : [],
    stopReason: error ? "error" : "stop",
    errorMessage: error,
    usage: {
      input: error ? 0 : 10,
      output: error ? 0 : 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: error ? 0 : 15,
      cost: {
        input: error ? 0 : 0.01,
        output: error ? 0 : 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: error ? 0 : 0.03,
      },
    },
  };
}
function fixture(
  failures: Record<string, string> = {},
  partial = false,
  preferred?: () => string | undefined,
) {
  const credentials = new InMemoryCredentialStore();
  const accounts = ["a", "b", "c"].map(
    (name): Account => ({
      id: name,
      name,
      provider: "test",
      credentialId: `account-${name}`,
      type: "oauth",
    }),
  );
  const calls: { key?: string; model: Model<Api>; options?: SimpleStreamOptions }[] = [];
  const attempts: AttemptUsage[] = [];
  const base: Provider = {
    id: "test",
    name: "Test",
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "API key",
        resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key ?? "AMBIENT" } }),
      },
      oauth: {
        name: "Subscription",
        isSubscription: true,
        login: async () => ({
          type: "oauth",
          access: "new",
          refresh: "r",
          expires: Date.now() + 600000,
        }),
        refresh: async (c) => ({ ...c, access: "refreshed", expires: Date.now() + 600000 }),
        toAuth: async (c) => ({
          apiKey: c.access,
          baseUrl: "https://oauth.invalid",
          headers: { "x-account": c.access },
        }),
      },
    },
    stream: (m, c, o) => base.streamSimple(m, c, o as SimpleStreamOptions),
    streamSimple: (m, _c, o) => {
      calls.push({ key: o?.apiKey, model: m, options: o });
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const err = failures[o?.apiKey ?? ""];
        await o?.onResponse?.(
          {
            status: err?.includes("429") ? 429 : err ? 400 : 200,
            headers: { "retry-after": "120" },
          },
          m,
        );
        const result = message(err, partial);
        stream.push({ type: "start", partial: result });
        if (partial)
          stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: result });
        if (o?.signal?.aborted) {
          result.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: result });
        } else if (err) stream.push({ type: "error", reason: "error", error: result });
        else stream.push({ type: "done", reason: "stop", message: result });
        stream.end();
      })();
      return stream;
    },
  };
  const client = createModels({ credentials });
  // The extension registers one model-less route slot per pooled credential; mirror that here.
  for (const account of accounts)
    client.setProvider(accountRouteProvider(base, account.credentialId, account.name));
  const router = new AccountRouter(
    {
      registerNativeProvider: (p) => client.setProvider(p),
      stream: client.stream.bind(client),
      streamSimple: client.streamSimple.bind(client),
    },
    (id) => credentials.read(id),
    async () => accounts,
    () => base,
    { attempt: (a) => attempts.push(a), preferred },
    () => 1000,
  );
  const ready = Promise.all(
    accounts.map((a) =>
      credentials.modify(a.credentialId, async () => ({
        type: "oauth",
        access: a.name,
        refresh: `refresh-${a.name}`,
        expires: Date.now() + 600000,
      })),
    ),
  );
  const run = async (options?: SimpleStreamOptions) => {
    await ready;
    return router.stream({ ...model, provider: "test" }, { messages: [] }, options).result();
  };
  return { router, accounts, credentials, calls, attempts, run, ready, base, model };
}

describe("routing contract", () => {
  test("session preference tries first, falls back in global order, respects cooldown and stays isolated", async () => {
    let preferred: string | undefined = "b";
    const f = fixture({ b: "429 rate limit" }, false, () => preferred);
    await f.run();
    expect(f.calls.map((c) => c.key)).toEqual(["b", "a"]);
    expect(f.accounts.map((a) => a.id)).toEqual(["a", "b", "c"]);
    f.calls.length = 0;
    await f.run();
    expect(f.calls.map((c) => c.key)).toEqual(["a"]);
    preferred = "c";
    f.calls.length = 0;
    await f.run();
    expect(f.calls.map((c) => c.key)).toEqual(["c"]);
    const other = fixture();
    await other.run();
    expect(other.calls.map((c) => c.key)).toEqual(["a"]);
    for (const missing of [undefined, "logged-out-account"]) {
      preferred = missing;
      f.calls.length = 0;
      await f.run();
      expect(f.calls.map((c) => c.key)).toEqual(["a"]);
    }
  });
  test("stale subscription metadata never routes a credential that became an API key", async () => {
    const f = fixture();
    await f.ready;
    await f.credentials.modify("account-a", async () => ({ type: "api_key", key: "paid-key" }));
    expect((await f.run()).stopReason).toBe("stop");
    expect(f.calls.map((c) => c.key)).toEqual(["b"]);
  });
  test("providers no longer marked as subscriptions cannot create or run an account route", async () => {
    const f = fixture();
    f.base.auth.oauth!.isSubscription = false;
    expect(f.router.provider("test")).toBeUndefined();
    expect((await f.run()).stopReason).toBe("error");
    expect(f.calls).toHaveLength(0);
  });
  test("a route keeps the source provider id and stays configured when only slots remain", async () => {
    const f = fixture();
    await f.ready;
    const route = f.router.provider("test")!;
    expect(route.id).toBe("test");
    expect(route.name).toBe("Test");
    expect(route.getModels().map((m) => m.provider)).toEqual(["test"]);
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const signal = new AbortController().signal;
    // Pi gates the request on auth, so the route must read as configured even with no
    // stored login under its own id (the original was removed, only slots remain).
    expect(await route.auth.apiKey?.resolve({ ctx, signal })).toEqual({ auth: {} });
    f.accounts.length = 0;
    expect(await route.auth.apiKey?.resolve({ ctx, signal })).toBeUndefined();
  });
  test("a credential replaced after selection cannot resolve through the API-key auth method", async () => {
    const f = fixture();
    await f.ready;
    const read = f.credentials.read.bind(f.credentials);
    let changed = false;
    f.credentials.read = async (id, options) => {
      const credential = await read(id, options);
      if (!changed && id === "account-a") {
        changed = true;
        await f.credentials.modify(id, async () => ({ type: "api_key", key: "paid-key" }));
      }
      return credential;
    };
    expect((await f.run()).stopReason).toBe("error");
    expect(f.calls).toHaveLength(0);
  });
  test.each(["cost", "delta", "input"])(
    "%s evidence prevents fallback and automatic compaction even when terminal totals are zero",
    async (kind) => {
      const f = fixture({ a: kind === "cost" ? "429" : "context_length_exceeded" });
      const original = f.base.streamSimple;
      f.base.streamSimple = (m, c, o) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          for await (const event of original(m, c, o)) {
            if (event.type === "error") {
              if (kind === "cost") event.error.usage.cost.input = 0.01;
              if (kind === "input") event.error.usage.input = 1;
              if (kind === "delta")
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: "already shown",
                  partial: event.error,
                });
            }
            stream.push(event);
          }
          stream.end();
        })();
        return stream;
      };
      const result = await f.run();
      expect(f.calls).toHaveLength(1);
      expect(result.stopReason).toBe("error");
      expect(isRetryableAssistantError(result)).toBe(false);
      expect(isContextOverflow(result, model.contextWindow)).toBe(false);
    },
  );
  test("priority falls back once per account on 429, records each attempt, and respects cooldown", async () => {
    const f = fixture({ a: "429 rate limit", b: "insufficient_quota" });
    expect((await f.run()).stopReason).toBe("stop");
    expect(f.calls.map((c) => c.key)).toEqual(["a", "b", "c"]);
    expect(f.attempts.map((a) => a.accountName)).toEqual(["a", "b", "c"]);
    expect(f.router.health.get("a")?.until).toBe(121000);
    await f.run();
    expect(f.calls.map((c) => c.key)).toEqual(["a", "b", "c", "c"]);
    expect(f.calls.every((c) => c.options?.maxRetries === 0)).toBe(true);
  });
  test("exhaustion terminates without a retry-triggering rate-limit error", async () => {
    const f = fixture({ a: "429", b: "429", c: "429" });
    const result = await f.run();
    expect(result.stopReason).toBe("error");
    expect(f.calls).toHaveLength(3);
    expect(limitReason(undefined, result.errorMessage!)).toBeUndefined();
    await f.run();
    expect(f.calls).toHaveLength(3);
  });
  test.each([
    "401 unauthorized",
    "403 forbidden",
    "500 server error",
    "network disconnected",
    "prompt is too long: 12000 tokens > 10000 maximum",
  ])("does not switch on %s", async (error) => {
    const f = fixture({ a: error });
    const result = await f.run();
    expect(result.stopReason).toBe("error");
    expect(f.calls).toHaveLength(1);
    if (error.startsWith("prompt")) {
      expect(result.errorMessage).toContain("context_length_exceeded");
      expect(isContextOverflow(result, model.contextWindow)).toBe(true);
    }
  });
  test("never replays after partial output", async () => {
    const f = fixture({ a: "429" }, true);
    const result = await f.run();
    expect(f.calls).toHaveLength(1);
    expect(isRetryableAssistantError(result)).toBe(false);
  });
  test("saved ranking is re-read for each request; removed accounts are excluded", async () => {
    const f = fixture();
    await f.run();
    f.accounts.reverse();
    await f.run();
    f.accounts.shift();
    await f.run();
    expect(f.calls.map((c) => c.key)).toEqual(["a", "c", "b"]);
  });
  test("missing credentials never borrow ambient auth; native model identity/options are retained", async () => {
    const f = fixture();
    await f.ready;
    await f.credentials.delete("account-a");
    const result = await f.run({
      apiKey: "should-not-leak",
      reasoning: "high",
      headers: { "x-test": "yes" },
      sessionId: "session",
    });
    expect(f.calls[0]?.key).toBe("b");
    expect(f.calls[0]?.model.provider).toBe("test");
    expect(f.calls[0]?.options?.reasoning).toBe("high");
    expect(f.calls[0]?.options?.headers?.["x-test"]).toBe("yes");
    expect(f.calls[0]?.options?.sessionId).toBe("session:b");
    expect(result.provider).toBe("test");
  });
  test("OAuth refresh persists under native credential orchestration and preserves account endpoint", async () => {
    const f = fixture();
    await f.ready;
    await f.credentials.modify("account-a", async () => ({
      type: "oauth",
      access: "expired",
      refresh: "private",
      expires: 0,
    }));
    await f.run();
    expect(f.calls[0]?.key).toBe("refreshed");
    expect(f.calls[0]?.model.baseUrl).toBe("https://oauth.invalid");
    expect(f.calls[0]?.options?.headers?.["x-account"]).toBe("refreshed");
    expect((await f.credentials.read("account-a"))?.type).toBe("oauth");
    expect(f.attempts[0]?.subscription).toBe(true);
  });
  test("aborted requests and closed runtimes never fall back", async () => {
    const f = fixture();
    const c = new AbortController();
    c.abort();
    expect((await f.run({ signal: c.signal })).stopReason).toBe("aborted");
    expect(f.calls).toHaveLength(0);
    f.router.close();
    expect((await f.run()).stopReason).toBe("aborted");
  });
  test("terminal protocol emits exactly one start and one done across fallback", async () => {
    const f = fixture({ a: "429" });
    await f.ready;
    const events = [];
    for await (const event of f.router.stream({ ...model, provider: "test" }, { messages: [] }))
      events.push(event.type);
    expect(events).toEqual(["start", "done"]);
  });
  test("reported usage prevents fallback even if totalTokens is missing from the total", async () => {
    const f = fixture({ a: "429" });
    const original = f.base.streamSimple;
    f.base.streamSimple = (m, c, o) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of original(m, c, o)) {
          if (event.type === "error") event.error.usage.input = 1;
          output.push(event);
        }
        output.end();
      })();
      return output;
    };
    const result = await f.run();
    expect(f.calls).toHaveLength(1);
    expect(isRetryableAssistantError(result)).toBe(false);
  });
  test("shutdown releases account-scoped cached transports exactly once", async () => {
    const f = fixture();
    const closed: string[] = [];
    const unregister = registerSessionResourceCleanup((id) => {
      if (id) closed.push(id);
    });
    try {
      await f.run();
      await f.run();
      f.router.close();
      f.router.close();
      expect(closed).toEqual(["pi:a"]);
    } finally {
      unregister();
    }
  });
  test("concurrent requests retain priority without swapping account credentials", async () => {
    const f = fixture();
    await Promise.all([f.run(), f.run(), f.run()]);
    expect(f.calls.map((c) => c.key)).toEqual(["a", "a", "a"]);
  });
  test("OAuth refresh failures stop without leaking provider exceptions or swapping credentials", async () => {
    const f = fixture();
    await f.ready;
    await f.credentials.modify("account-a", async () => ({
      type: "oauth",
      access: "expired",
      refresh: "private",
      expires: 0,
    }));
    f.base.auth.oauth!.refresh = async () => {
      throw new Error("SECRET refresh token");
    };
    const result = await f.run();
    expect(result.errorMessage).not.toContain("SECRET");
    expect(f.calls).toHaveLength(0);
    expect(f.attempts).toHaveLength(1);
    expect((await f.credentials.read("account-a"))?.type).toBe("oauth");
  });
  test("provider-specific quota codes and permission errors are classified conservatively", () => {
    for (const message of [
      "GoUsageLimitError",
      "FreeUsageLimitError",
      "Monthly usage limit reached",
      "out of budget",
      // Real pi-ai Codex strings: a stream error event has no HTTP status to lean on.
      "Codex error: The usage limit has been reached",
      "You have hit your ChatGPT usage limit (pro plan). Try again in ~990 min.",
      "usage_limit_reached",
    ])
      expect(limitReason(undefined, message)).toBe("quota");
    expect(limitReason(undefined, "ResourceExhausted")).toBe("rate limit");
    expect(limitReason(401, "rate limit")).toBeUndefined();
    expect(limitReason(403, "quota exceeded")).toBeUndefined();
    // A limit that was explicitly *not* reached is not a terminal limit.
    expect(limitReason(undefined, "usage limit not reached")).toBeUndefined();
    expect(limitReason(undefined, "the usage limit was not reached")).toBeUndefined();
  });
  test("cooldown parsing handles dates, missing/invalid values and quota defaults", () => {
    expect(retryAt("120", 1000, "rate limit")).toBe(121000);
    expect(retryAt("Thu, 01 Jan 1970 00:02:00 GMT", 1000, "rate limit")).toBe(120000);
    expect(retryAt("bad", 1000, "quota")).toBe(3601000);
    expect(retryAt("", 1000, "rate limit")).toBe(61000);
  });
});
