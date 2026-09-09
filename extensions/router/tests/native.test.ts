import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Provider,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import { AccountRouter } from "../router.ts";
import { poolId, type Account } from "../store.ts";
import { accountLoginProvider } from "../../../src/account-identity.ts";

test("real Pi ModelRuntime routes subscription auth without touching or borrowing the original API login", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("native-test", async () => ({ type: "api_key", key: "original" }));
  await credentials.modify("account-a", async () => ({
    type: "oauth",
    access: "separate",
    refresh: "fake-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const calls: string[] = [];
  const model: Model<Api> = {
    id: "model",
    provider: "native-test",
    name: "Test",
    api: "openai-completions",
    baseUrl: "https://invalid.example",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000,
    maxTokens: 1000,
  };
  const base: Provider = {
    id: "native-test",
    name: "Native Test",
    getModels: () => [model],
    auth: {
      oauth: {
        name: "Subscription",
        isSubscription: true,
        login: async () => ({
          type: "oauth",
          access: "separate",
          refresh: "fake-refresh",
          expires: Date.now() + 3600000,
        }),
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
      apiKey: {
        name: "Native key",
        login: async () => ({ type: "api_key", key: "login" }),
        resolve: async ({ credential }) =>
          credential ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
    stream: () => {
      throw new Error("Only simple expected");
    },
    streamSimple: (m, _c, options) => {
      calls.push(options?.apiKey ?? "missing");
      expect(m.provider).toBe("native-test");
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        api: model.api,
        provider: m.provider,
        model: m.id,
        content: [],
        timestamp: Date.now(),
        stopReason: "stop" as const,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  };
  runtime.registerNativeProvider(base);
  const accounts: Account[] = [
    {
      id: "a",
      name: "personal",
      provider: base.id,
      credentialId: "account-a",
      type: "oauth",
    },
  ];
  // Separate native runtime as in the extension, sharing only Pi's credential store.
  const accountRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const router = new AccountRouter(
    accountRuntime,
    (id) => credentials.read(id),
    async () => accounts,
    (id) => runtime.getProvider(id),
  );
  const login = accountLoginProvider(base, accounts[0]!.credentialId, accounts[0]!.name);
  expect(login.getModels()).toEqual([]);
  expect(login.auth.apiKey?.login).toBeDefined();
  runtime.registerNativeProvider(login);
  runtime.registerNativeProvider(router.provider(base.id)!);
  const pooled = runtime.getModel(poolId(base.id), model.id)!;
  expect(pooled).toBeDefined();
  const result = await runtime.completeSimple(pooled, { messages: [] });
  expect(result.stopReason).toBe("stop");
  expect(calls).toEqual(["separate"]);
  expect(((await credentials.read(base.id)) as { key: string }).key).toBe("original");
  expect(result.provider).toBe(poolId(base.id));
  router.close();
});
