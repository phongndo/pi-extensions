import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  retryAssistantCall,
  type Api,
  type AssistantMessage,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createEventBus,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createRouterExtension } from "../index.ts";
import { SESSION_ACCOUNT_ENTRY } from "../session.ts";
import { loginId } from "../../../src/account-identity.ts";
import { DIAGNOSTIC_ENTRY } from "../diagnostics.ts";

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
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendCustomEntry(SESSION_ACCOUNT_ENTRY, {
    provider: "test",
    accountId: loginId("test", 2),
  });
  const commands = new Map<
    string,
    { handler: (args: string, context: ExtensionCommandContext) => Promise<void> }
  >();
  const notices: string[] = [];
  const ctx = {
    model: { ...model, provider: "test" },
    modelRegistry: new ModelRegistry(appRuntime),
    isIdle: () => true,
    hasUI: true,
    mode: "tui",
    sessionManager,
    ui: { notify: (text: string) => notices.push(text), setStatus: () => {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: createEventBus(),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerCommand: (
      name: string,
      command: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
    ) => commands.set(name, command),
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
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

    // A real app-runtime -> public provider -> router-runtime -> native provider request
    // must retain HTTP-only recovery signals, not just direct AccountRouter invocations.
    const success = base.streamSimple;
    let fail = true;
    base.streamSimple = (m, c, options) => {
      if (!fail) return success(m, c, options);
      calls.push(options?.apiKey ?? "missing");
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onResponse?.({ status: 503, headers: {} }, m);
        const error: AssistantMessage = {
          ...result,
          content: [],
          stopReason: "error",
          errorMessage: "Upstream temporarily unavailable. Bearer sensitive-provider-token",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "error", reason: "error", error });
        stream.end();
      })();
      return stream;
    };
    const recovered = await retryAssistantCall(
      () => appRuntime.completeSimple(route!, { messages: [] }),
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
      undefined,
      {
        onRetryScheduled: (_attempt, _max, _delay, error) => {
          expect(error).toContain("HTTP 503");
          expect(error).not.toContain("PRIVATE");
          fail = false;
        },
      },
    );
    expect(recovered.stopReason).toBe("stop");
    expect(calls).toEqual(["two", "two", "two"]);
    const errors = sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === DIAGNOSTIC_ENTRY);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).toContain("Upstream temporarily unavailable");
    expect(JSON.stringify(errors)).not.toContain("sensitive-provider-token");
    expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain(
      "Upstream temporarily unavailable",
    );
    const command = commands.get("router")!;
    await command.handler("errors", ctx as ExtensionCommandContext);
    expect(notices.at(-1)).toContain("HTTP 503");
    expect(notices.at(-1)).toContain("Upstream temporarily unavailable");
    await hooks.get("session_start")!({} as never, ctx);
    await command.handler("errors", ctx as ExtensionCommandContext);
    expect(notices.at(-1)).toContain("Upstream temporarily unavailable");
    // A full/unwritable session store must not replace the provider failure or lose the
    // in-memory diagnostic. Read-only inspection still works without persistence.
    pi.appendEntry = () => {
      throw new Error("Session storage unavailable");
    };
    fail = true;
    const storageFailure = await appRuntime.completeSimple(route!, { messages: [] });
    expect(storageFailure.errorMessage).toContain("HTTP 503");
    await command.handler("errors", ctx as ExtensionCommandContext);
    expect(notices.at(-1)?.match(/HTTP 503/g)).toHaveLength(2);
    // Diagnostics remain available when routing itself cannot refresh metadata.
    writeFileSync(join(directory, "router.json"), "{invalid");
    Object.assign(ctx, { isIdle: () => false });
    await command.handler("errors", ctx as ExtensionCommandContext);
    expect(notices.at(-1)).toContain("Upstream temporarily unavailable");
  } finally {
    await hooks.get("session_shutdown")?.({} as never, ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
