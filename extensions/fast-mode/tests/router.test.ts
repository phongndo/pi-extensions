import { expect, test } from "bun:test";
import { resolveFastCapability, isCodexModel } from "../capabilities.ts";
import { model, token } from "./helpers.ts";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Provider,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { AccountRouter } from "../../router/router.ts";
import { accountRouteProvider } from "../../../src/account-identity.ts";
import { installFastModeProviderLookup } from "../runtime.ts";

test("the subscription account route retains Codex Fast capability; unrelated providers do not", () => {
  const native = model();
  expect(resolveFastCapability({ ...native, provider: "accounts-openai-codex" })).toEqual(
    resolveFastCapability(native),
  );
  expect(isCodexModel({ ...native, provider: "accounts-openai" })).toBe(false);
  expect(isCodexModel({ ...native, provider: "account--openai-codex--2" })).toBe(false);
  expect(
    isCodexModel({ ...native, provider: "accounts-openai-codex", api: "openai-responses" }),
  ).toBe(false);
});

test("account routing preserves native Fast payload policy and account-specific auth without double application", async () => {
  const credentials = new InMemoryCredentialStore();
  const credentialId = "account--openai-codex--2";
  await credentials.modify(credentialId, async () => ({
    type: "oauth",
    access: token("work"),
    refresh: "fake-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const native = model();
  const payloads: unknown[] = [];
  const original = runtime.getProvider("openai-codex")!;
  const base: Provider = {
    ...original,
    getModels: () => [native],
    streamSimple: (m, _c, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        expect(m.provider).toBe("openai-codex");
        expect(options?.apiKey).toBe(token("work"));
        const payload = { model: m.id };
        payloads.push((await options?.onPayload?.(payload, m)) ?? payload);
        const message: AssistantMessage = {
          role: "assistant",
          api: m.api,
          model: m.id,
          provider: m.provider,
          content: [],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      })();
      return stream;
    },
  };
  runtime.registerNativeProvider(base);
  let enabled = true,
    policyReads = 0;
  const remove = installFastModeProviderLookup(registry, async () => {
    policyReads++;
    return enabled;
  });
  const routerRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const router = new AccountRouter(
    routerRuntime,
    (id) => credentials.read(id),
    async () => [
      { id: credentialId, credentialId, provider: base.id, name: "Work", type: "oauth" },
    ],
    () => base,
  );
  try {
    routerRuntime.registerNativeProvider(accountRouteProvider(base, credentialId, "Work"));
    runtime.registerNativeProvider(router.provider(base.id)!);
    const route = registry.find("openai-codex", native.id)!;
    expect(resolveFastCapability(route).status).toBe("supported");
    expect((await runtime.completeSimple(route, { messages: [] })).stopReason).toBe("stop");
    enabled = false;
    expect((await runtime.completeSimple(route, { messages: [] })).stopReason).toBe("stop");
    expect(payloads).toEqual([
      { model: native.id, service_tier: "priority" },
      { model: native.id },
    ]);
    expect(policyReads).toBe(2);
  } finally {
    router.close();
    remove();
  }
});
