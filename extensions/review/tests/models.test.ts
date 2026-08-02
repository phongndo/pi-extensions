import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthResult,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createChildModelRuntime,
  ensureModelAuth,
  resolveRoleModels,
  supportedThinkingLevels,
} from "../child-session.ts";
import { defaultSettings } from "../settings.ts";

function model(
  reasoning: boolean,
  thinkingLevelMap?: Model<"openai-responses">["thinkingLevelMap"],
): Model<"openai-responses"> {
  return {
    id: "test",
    name: "Test",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevelMap,
  };
}

class TestCredentialStore implements CredentialStore {
  private readonly values = new Map<string, Credential>();

  constructor(providerId: string, credential: Credential) {
    this.values.set(providerId, credential);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.values.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.values].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await update(this.values.get(providerId));
    if (next) this.values.set(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.values.delete(providerId);
  }
}

test("propagates model authentication resolver failures", async () => {
  const failure = new Error("credential refresh failed");
  const runtime = {
    getAuth: async () => {
      throw failure;
    },
  } as unknown as ModelRuntime;

  await assert.rejects(
    ensureModelAuth(runtime, model(false)),
    (error: unknown) => error === failure,
  );
});

test("offers only supported thinking levels", () => {
  assert.deepEqual(supportedThinkingLevels(model(false)), ["off"]);
  assert.deepEqual(supportedThinkingLevels(model(true, { xhigh: "xhigh", max: null })), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("child runtimes preserve authenticated native extension providers", async () => {
  const native: Provider<"openai-responses"> = {
    id: "test",
    name: "Native test",
    auth: {
      apiKey: {
        name: "Native test key",
        resolve: async () => ({
          auth: {
            apiKey: "native-key",
            headers: { "x-native-auth": "present" },
            baseUrl: "https://native-effective.example.test",
          },
          source: "native test",
        }),
      },
    },
    getModels: () => [model(false)],
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
  const outerRuntime = await ModelRuntime.create({ modelsPath: null });
  outerRuntime.registerNativeProvider(native);
  const outerRegistry = new ModelRegistry(outerRuntime);
  await outerRuntime.refresh({ allowNetwork: false });
  const effective = await outerRegistry.getProviderAuth("test");
  const child = await createChildModelRuntime(
    outerRegistry,
    undefined,
    new Map([["test", effective]]),
  );

  assert.ok(child.getRegisteredNativeProvider("test"));
  assert.equal(child.getRegisteredProviderConfig("test"), undefined);
  assert.equal(child.getModel("test", "test")?.id, "test");
  assert.equal((await child.getAuth("test"))?.auth.apiKey, "native-key");
  assert.ok((await child.getAvailable("test")).some((candidate) => candidate.id === "test"));

  const resolved = await resolveRoleModels({
    settings: {
      ...defaultSettings(),
      reviewerModel: { provider: "test", modelId: "test" },
      fixerModel: { provider: "test", modelId: "test" },
    },
    currentModel: undefined,
    currentThinking: "medium",
    outerRegistry,
  });
  assert.equal(resolved.reviewerModel.id, "test");
  assert.equal(resolved.fixerModel.id, "test");
});

test("child runtimes refresh transferred model catalogs without network access", async () => {
  const allowNetwork: boolean[] = [];
  const native: Provider<"openai-responses"> = {
    id: "test",
    name: "Dynamic native test",
    auth: {
      apiKey: {
        name: "Dynamic native test key",
        resolve: async () => ({ auth: { apiKey: "native-key" } }),
      },
    },
    getModels: () => [model(false)],
    refreshModels: async (context) => {
      allowNetwork.push(context.allowNetwork);
    },
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
  const outerRuntime = await ModelRuntime.create({ modelsPath: null });
  outerRuntime.registerNativeProvider(native);
  await outerRuntime.refresh({ allowNetwork: false });
  const outerRegistry = new ModelRegistry(outerRuntime);
  const effective = await outerRegistry.getProviderAuth("test");
  allowNetwork.length = 0;

  await createChildModelRuntime(
    outerRegistry,
    undefined,
    new Map([["test", effective]]),
    new Map([["test", new Set(["test"])]]),
  );

  assert.ok(allowNetwork.length > 0);
  assert.equal(
    allowNetwork.every((allowed) => !allowed),
    true,
  );
});

test("child runtimes preserve header-only auth for built-in OAuth providers", async () => {
  const outerRuntime = await ModelRuntime.create({ modelsPath: null });
  const outerRegistry = new ModelRegistry(outerRuntime);
  const selected = outerRegistry.getAll().find((candidate) => candidate.provider === "kimi-coding");
  assert.ok(selected);
  const effective: AuthResult = {
    auth: { headers: { Authorization: "Bearer subscription-token" } },
    source: "OAuth",
  };

  const child = await createChildModelRuntime(
    outerRegistry,
    undefined,
    new Map([["kimi-coding", effective]]),
    new Map([["kimi-coding", new Set([selected.id])]]),
  );
  const childAuth = await child.getAuth(selected);
  assert.equal(childAuth?.auth.apiKey, undefined);
  assert.equal(childAuth?.auth.headers?.Authorization, "Bearer subscription-token");
  await assert.doesNotReject(ensureModelAuth(child, selected));
  assert.ok((await child.getAvailable("kimi-coding")).some((model) => model.id === selected.id));
});

test("role preflight honors outer account-filtered model availability", async () => {
  const native: Provider<"openai-responses"> = {
    id: "test",
    name: "Filtered native test",
    auth: {
      apiKey: {
        name: "Filtered key",
        resolve: async () => ({ auth: { apiKey: "key" } }),
      },
    },
    getModels: () => [model(false)],
    filterModels: () => [],
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
  const outerRuntime = await ModelRuntime.create({ modelsPath: null });
  outerRuntime.registerNativeProvider(native);
  const outerRegistry = new ModelRegistry(outerRuntime);
  await outerRuntime.refresh({ allowNetwork: false });

  await assert.rejects(
    resolveRoleModels({
      settings: {
        ...defaultSettings(),
        reviewerModel: { provider: "test", modelId: "test" },
        fixerModel: { provider: "test", modelId: "test" },
      },
      currentModel: undefined,
      currentThinking: "medium",
      outerRegistry,
    }),
    /selected outer-session account/,
  );
});

test("outer role-model preflight aborts without waiting for provider authentication", async () => {
  const selected = model(false);
  const outerRegistry = {
    getAvailable: () => [selected],
    find: () => selected,
    isUsingOAuth: () => false,
    getProviderAuth: () => new Promise<AuthResult | undefined>(() => undefined),
  } as unknown as ModelRegistry;
  const controller = new AbortController();
  const pending = resolveRoleModels({
    settings: {
      ...defaultSettings(),
      reviewerModel: { provider: "test", modelId: "test" },
      fixerModel: { provider: "test", modelId: "test" },
    },
    currentModel: undefined,
    currentThinking: "medium",
    outerRegistry,
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("child runtimes preserve effective outer runtime authentication", async () => {
  const outerRuntime = await ModelRuntime.create({
    credentials: new TestCredentialStore("test", { type: "api_key", key: "stored-key" }),
    modelsPath: null,
  });
  outerRuntime.registerProvider("test", {
    api: "openai-responses",
    apiKey: "configured-key",
    baseUrl: "https://configured.example.test",
    models: [
      {
        id: "test",
        name: "Test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000,
        maxTokens: 100,
      },
    ],
  });
  await outerRuntime.setRuntimeApiKey("test", "outer-runtime-key");
  const outerRegistry = new ModelRegistry(outerRuntime);
  const effective = await outerRegistry.getProviderAuth("test");
  assert.equal(effective?.auth.apiKey, "outer-runtime-key");

  const transferred: AuthResult = {
    auth: {
      ...effective?.auth,
      headers: { "x-effective-auth": "present" },
      baseUrl: "https://effective.example.test",
    },
    env: { EFFECTIVE_ACCOUNT: "selected" },
  };
  const child = await createChildModelRuntime(
    outerRegistry,
    undefined,
    new Map([["test", transferred]]),
  );
  const childAuth = await child.getAuth("test");
  assert.equal(childAuth?.auth.apiKey, "outer-runtime-key");
  assert.equal(childAuth?.auth.headers?.["x-effective-auth"], "present");
  assert.equal(child.getModel("test", "test")?.baseUrl, "https://effective.example.test");
  assert.equal(childAuth?.env?.EFFECTIVE_ACCOUNT, "selected");
});
