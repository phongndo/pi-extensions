import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventBus,
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import { createRouterExtension } from "../index.ts";
import { RankingStore, poolId } from "../store.ts";
import { loginId, nativeAccounts, type NativeAccount } from "../../../src/account-identity.ts";

test("native login/logout own accounts; /router only ranks multi-account providers and automatically routes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-router-command-"));
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let context: ExtensionCommandContext | undefined;
  try {
    const path = join(directory, "router.json");
    const store = new RankingStore(path);
    const credentials = new InMemoryCredentialStore();
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    let loginNumber = 0;
    const base: Provider = {
      id: "test",
      name: "Test",
      auth: {
        oauth: {
          name: "Test subscription",
          isSubscription: true,
          login: async () => ({
            type: "oauth",
            access: `token-${++loginNumber}`,
            refresh: `refresh-${loginNumber}`,
            expires: Date.now() + 3600000,
          }),
          refresh: async (c) => c,
          toAuth: async (c) => ({ apiKey: c.access }),
        },
      },
      getModels: () => [
        {
          id: "model",
          name: "Test",
          provider: "test",
          api: "openai-completions",
          baseUrl: "https://test.invalid",
          reasoning: false,
          input: ["text"],
          contextWindow: 10000,
          maxTokens: 1000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      stream: () => {
        throw new Error("No requests expected");
      },
      streamSimple: () => {
        throw new Error("No requests expected");
      },
    };
    runtime.registerNativeProvider(base);
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    >();
    const notices: string[] = [];
    const statuses = new Map<string, string | undefined>();
    let busy = false;
    let result: NativeAccount[] | undefined;
    let dialogs = 0;
    let aliasInput: string | undefined;
    let selectAccount = 0;
    const published: NativeAccount[][] = [];
    context = {
      hasUI: true,
      mode: "tui",
      isIdle: () => !busy,
      model: base.getModels()[0],
      modelRegistry: new ModelRegistry(runtime),
      sessionManager: { getSessionId: () => "session" },
      ui: {
        setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
        notify: (text: string) => notices.push(text),
        select: async (_title: string, options: string[]) => options[selectAccount],
        input: async () => aliasInput,
        custom: async () => {
          dialogs++;
          return result;
        },
      },
    } as unknown as ExtensionCommandContext;
    const pi = {
      events: createEventBus(),
      on: (name: string, fn: (event: never, ctx: ExtensionContext) => unknown) =>
        handlers.set(name, fn),
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => commands.set(name, command),
      registerProvider: (p: Provider) => runtime.registerNativeProvider(p),
      unregisterProvider: (id: string) => runtime.unregisterProvider(id),
      setModel: async (model: ExtensionContext["model"]) => {
        Object.assign(context!, { model });
        return true;
      },
    } as unknown as ExtensionAPI;
    pi.events.on("router:accounts", (value) => published.push(value as NativeAccount[]));
    await createRouterExtension({
      configPath: path,
      legacyPath: join(directory, "absent.json"),
      credentials,
      providers: [base],
      modelsPath: null,
      pollMs: 60_000,
    })(pi);
    await handlers.get("session_start")!({} as never, context);
    expect(statuses.get("router")).toBeUndefined();
    const command = commands.get("router")!;
    expect([...commands.keys()]).toEqual(["router"]);
    await command.handler("", context);
    expect(dialogs).toBe(0);
    expect(context.model?.provider).toBe("test");
    const interaction = { prompt: async () => "", notify: () => {} };
    await runtime.login("test", "oauth", interaction);
    await handlers.get("input")!({} as never, context);
    expect(statuses.get("router")).toBe("Account: Account 1");
    expect(runtime.getProvider(loginId("test", 2))).toBeUndefined();
    expect(runtime.getProvider(poolId("test"))).toBeUndefined();
    await command.handler("", context);
    expect(dialogs).toBe(0);
    aliasInput = "Personal";
    await command.handler("alias", context); // Even single-account providers can have aliases.
    expect(store.readAliases()).toEqual({ "native:test": "Personal" });
    expect(published.at(-1)?.[0]?.name).toBe("Personal");
    expect(statuses.get("router")).toBe("Account: Personal");
    expect(store.read()).toEqual({});
    // The same public login/logout operations used by Pi's built-in slash commands.
    await runtime.login("test", "oauth", interaction);
    await handlers.get("input")!({} as never, context);
    expect(context.model?.provider).toBe(poolId("test"));
    expect(runtime.getProvider(loginId("test", 3))).toBeUndefined();
    expect(runtime.getProvider(loginId("test", 2))?.name).toContain("Account 2");
    loginNumber = 1; // Repeat token-2 accidentally: refresh it, don't create account 3.
    await runtime.login("test", "oauth", interaction);
    expect(await runtime.listCredentials()).toHaveLength(2);
    expect(await credentials.read(loginId("test", 3))).toBeUndefined();
    await command.handler("", context); // cancellation
    expect(store.read()).toEqual({});
    result = nativeAccounts([base], await runtime.listCredentials())
      .map((a) => ({ ...a, alias: a.id === "native:test" ? "Personal" : "Work" }))
      .reverse();
    await command.handler("", context);
    expect(store.read().test).toEqual([loginId("test", 2), "native:test"]);
    expect(store.readAliases()).toEqual({
      "native:test": "Personal",
      [loginId("test", 2)]: "Work",
    });
    expect(runtime.getProvider(loginId("test", 2))?.name).toContain("Work");
    expect(statuses.get("router")).toBe("Account: Work");
    loginNumber = 1;
    await runtime.login("test", "oauth", interaction);
    expect(store.readAliases()[loginId("test", 2)]).toBe("Work");
    selectAccount = 1; // Ranking order is Work, Personal.
    aliasInput = undefined;
    await command.handler("alias", context);
    expect(store.readAliases()["native:test"]).toBe("Personal");
    aliasInput = "";
    await command.handler("alias", context);
    expect(store.readAliases()["native:test"]).toBeUndefined();
    expect(store.read().test).toEqual([loginId("test", 2), "native:test"]);
    expect(published.at(-1)?.find((a) => a.id === "native:test")?.name).toBe("Account 1");
    const before = await credentials.list();
    await command.handler("add", context);
    expect(notices.at(-1)).toContain("Use /login and /logout");
    expect(await credentials.list()).toEqual(before);
    busy = true;
    await command.handler("", context);
    expect(notices.at(-1)).toContain("Stop the current response");
    busy = false;
    await runtime.logout(loginId("test", 2));
    expect(store.readAliases()).toEqual({});
    await handlers.get("input")!({} as never, context);
    expect(context.model?.provider).toBe("test");
    const priorDialogs = dialogs;
    await command.handler("", context);
    expect(dialogs).toBe(priorDialogs);
    expect((await credentials.read("test"))?.type).toBe("oauth");
    expect(await credentials.read(loginId("test", 2))).toBeUndefined();
    expect(statuses.get("router")).toBe("Account: Account 1");
    Object.assign(context, { model: undefined });
    await handlers.get("model_select")!({} as never, context);
    expect(statuses.get("router")).toBeUndefined();
  } finally {
    if (context) await handlers.get("session_shutdown")?.({} as never, context);
    rmSync(directory, { recursive: true, force: true });
  }
});
