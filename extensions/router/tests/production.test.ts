import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRouterExtension } from "../index.ts";
import { SESSION_ACCOUNT_ENTRY } from "../session.ts";
import { loginId } from "../../../src/account-identity.ts";

const oauth = (access: string) => ({
  type: "oauth" as const,
  access,
  refresh: access,
  expires: Date.now() + 3_600_000,
});
const model: Model<Api> = {
  id: "model",
  name: "Model",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://test.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 10_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/**
 * The router streams through the ModelRuntime it creates internally, which is a different
 * instance from Pi's registry that `pi.registerProvider` targets. This reproduces that split
 * so a routed request actually reaches a stream instead of failing with `Unknown provider`.
 */
test("a transparently routed request streams through the extension runtime with its slots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-router-production-"));
  const credentials = new InMemoryCredentialStore();
  const appRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const calls: string[] = [];
  const base: Provider = {
    id: "test",
    name: "Test",
    getModels: () => [model],
    auth: {
      oauth: {
        name: "Subscription",
        isSubscription: true,
        login: async () => oauth("fresh"),
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    stream: () => {
      throw new Error("Only streamSimple is expected");
    },
    streamSimple: (m, _c, options) => {
      calls.push(options?.apiKey ?? "missing");
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: m.api,
        provider: m.provider,
        model: m.id,
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
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  };
  appRuntime.registerNativeProvider(base);
  await credentials.modify("test", async () => oauth("one"));
  await credentials.modify(loginId("test", 2), async () => oauth("two"));

  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  // Prefer the second login. If the pool wrapper were not the streaming provider (e.g. the
  // extension-local slot replaced it on a shared runtime), routing would be bypassed and
  // the first login would be used instead.
  const branch = [
    {
      type: "custom",
      customType: SESSION_ACCOUNT_ENTRY,
      data: { provider: "test", accountId: loginId("test", 2) },
    },
  ];
  const ctx = {
    model: { ...model, provider: "test" },
    modelRegistry: new ModelRegistry(appRuntime),
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session", getBranch: () => branch },
    ui: {},
  } as unknown as ExtensionContext;
  const pi = {
    events: createEventBus(),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerCommand: () => {},
    registerProvider: (provider: Provider) => appRuntime.registerNativeProvider(provider),
    unregisterProvider: (id: string) => appRuntime.unregisterProvider(id),
    setModel: async (next: ExtensionContext["model"]) => {
      Object.assign(ctx, { model: next });
      return true;
    },
  } as unknown as ExtensionAPI;
  try {
    await createRouterExtension({
      credentials,
      providers: [base],
      modelsPath: null,
      configPath: join(directory, "router.json"),
      legacyPath: join(directory, "absent.json"),
      pollMs: 60_000,
    })(pi);
    await hooks.get("session_start")!({} as never, ctx);
    const route = appRuntime.getModel("test", model.id);
    expect(route).toBeDefined();
    const result = await appRuntime.completeSimple(route!, { messages: [] });
    expect(result.stopReason).toBe("stop");
    expect(calls).toEqual(["two"]); // Session preference routed to the second slot.
  } finally {
    await hooks.get("session_shutdown")?.({} as never, ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
