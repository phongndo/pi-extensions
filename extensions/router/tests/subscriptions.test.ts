import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRouterExtension } from "../index.ts";
import {
  isSubscriptionAccount,
  loginId,
  nativeAccounts,
  poolId,
  type NativeAccount,
} from "../../../src/account-identity.ts";
const oauth = (access: string) => ({
  type: "oauth" as const,
  access,
  refresh: access,
  expires: Date.now() + 3600000,
});

test("native metadata admits future subscriptions, excludes API keys and non-subscription OAuth", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const codex = runtime.getProvider("openai-codex")!;
  const future: Provider = {
    ...codex,
    id: "future",
    auth: { ...codex.auth, apiKey: envApiKeyAuth("Key", []) },
  };
  const nonSub: Provider = {
    ...future,
    id: "not-sub",
    auth: { ...future.auth, oauth: { ...future.auth.oauth!, isSubscription: false } },
  };
  const providers = [future, nonSub];
  const accounts = nativeAccounts(providers, [
    { providerId: "future", type: "oauth" },
    { providerId: loginId("future", 2), type: "api_key" },
    { providerId: "not-sub", type: "oauth" },
  ]);
  expect(accounts).toHaveLength(3); // Generic discovery remains non-destructive.
  expect(
    accounts
      .filter((a) =>
        isSubscriptionAccount(
          a,
          providers.find((p) => p.id === a.provider),
        ),
      )
      .map((a) => a.id),
  ).toEqual(["native:future"]);
});

test("extension routes only subscriptions; old API slots stay removable and new API/non-sub logins remain native", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sub-router-"));
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const codex = runtime.getProvider("openai-codex")!;
  let loginNumber = 0;
  const future: Provider = {
    ...codex,
    id: "future",
    name: "Future subscription",
    getModels: () =>
      codex
        .getModels()
        .slice(0, 1)
        .map((m) => ({ ...m, provider: "future" })),
    auth: {
      apiKey: {
        ...envApiKeyAuth("Key", []),
        login: async () => ({ type: "api_key", key: `new-key-${++loginNumber}` }),
      },
      oauth: { ...codex.auth.oauth!, login: async () => oauth(`oauth-${++loginNumber}`) },
    },
  };
  const nonSub: Provider = {
    ...future,
    id: "not-sub",
    auth: { ...future.auth, oauth: { ...future.auth.oauth!, isSubscription: false } },
  };
  for (const p of [future, nonSub]) runtime.registerNativeProvider(p);
  await credentials.modify("future", async () => oauth("one"));
  await credentials.modify(loginId("future", 2), async () => ({
    type: "api_key",
    key: "excluded-key",
  }));
  await credentials.modify(loginId("future", 3), async () => oauth("three"));
  await credentials.modify("not-sub", async () => oauth("non-sub"));
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const events = createEventBus();
  let published: NativeAccount[] = [];
  let routed: string[] = [];
  events.on("router:accounts", (value) => {
    published = value as NativeAccount[];
  });
  events.on("router:routes", (value) => {
    routed = value as string[];
  });
  const ctx = {
    model: future.getModels()[0],
    modelRegistry: new ModelRegistry(runtime),
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    ui: {},
  } as unknown as ExtensionContext;
  const pi = {
    events,
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerCommand: () => {},
    registerProvider: (p: Provider) => runtime.registerNativeProvider(p),
    unregisterProvider: (id: string) => runtime.unregisterProvider(id),
    setModel: async (model: ExtensionContext["model"]) => {
      Object.assign(ctx, { model });
      return true;
    },
  } as unknown as ExtensionAPI;
  try {
    await createRouterExtension({
      credentials,
      providers: [future, nonSub],
      modelsPath: null,
      configPath: join(directory, "router.json"),
      legacyPath: join(directory, "absent"),
      pollMs: 60000,
    })(pi);
    await hooks.get("session_start")!({} as never, ctx);
    expect(published.map((a) => a.credentialId)).toEqual(["future", loginId("future", 3)]);
    // The router names which providers it pools, so consumers never re-derive the rule.
    expect(routed).toEqual(["future"]);
    expect(ctx.model?.provider).toBe("future");
    expect(runtime.getProvider(poolId("not-sub"))).toBeUndefined();
    expect(runtime.getProvider(loginId("future", 2))?.getModels()).toEqual([]);
    expect((await credentials.read(loginId("future", 2)))?.type).toBe("api_key");
    const interaction = { prompt: async () => "", notify: () => {} };
    await runtime.login("future", "api_key", interaction);
    await runtime.login("future", "api_key", interaction);
    await runtime.login("not-sub", "oauth", interaction);
    await runtime.login("not-sub", "oauth", interaction);
    await hooks.get("input")!({} as never, ctx);
    expect(await credentials.read(loginId("future", 4))).toBeUndefined();
    expect(await credentials.read(loginId("not-sub", 2))).toBeUndefined();
    expect(published.map((a) => a.credentialId)).toEqual([loginId("future", 3)]);
    await runtime.logout(loginId("future", 2));
    expect(await credentials.read(loginId("future", 2))).toBeUndefined();
    expect(await credentials.read(loginId("future", 3))).toMatchObject({
      type: "oauth",
      access: "three",
    });
  } finally {
    await hooks.get("session_shutdown")?.({} as never, ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
