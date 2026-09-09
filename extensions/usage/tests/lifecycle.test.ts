import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEventBus,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createUsageExtension } from "../index.ts";
import { UsageLedger } from "../ledger.ts";
import * as live from "../live.ts";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

test("command opens cancellable native UI before history finishes loading", async () => {
  initTheme("dark", false);
  let release!: (value: { records: []; skipped: number }) => void;
  const read = spyOn(UsageLedger.prototype, "read").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let opened = false;
  let cancelledSignal: AbortSignal | undefined;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: () => {},
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        opened = true;
        let close!: () => void;
        const closed = new Promise<void>((resolve) => {
          close = resolve;
        });
        const component = await factory(
          { requestRender: () => {}, terminal: { rows: 30 } } as Parameters<typeof factory>[0],
          { fg: (_: string, s: string) => s } as Parameters<typeof factory>[1],
          new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2],
          close,
        );
        cancelledSignal = (component as unknown as { signal: AbortSignal }).signal;
        component.handleInput?.("\u001b");
        component.dispose?.();
        await closed;
      },
    },
  } as unknown as ExtensionCommandContext;
  createUsageExtension({ live: false })({
    events: createEventBus(),
    on: () => {},
    registerCommand: (_: string, value: { handler: typeof command }) => {
      command = value.handler;
    },
  } as unknown as ExtensionAPI);
  const pending = command("", ctx);
  try {
    await Promise.resolve();
    expect(opened).toBe(true);
    await pending;
    expect(cancelledSignal?.aborted).toBe(true);
  } finally {
    release?.({ records: [], skipped: 0 });
    await pending;
    read.mockRestore();
  }
});

test("history and live limits start concurrently rather than serially", async () => {
  let release!: (value: { records: []; skipped: number }) => void;
  const read = spyOn(UsageLedger.prototype, "read").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const limits = spyOn(live, "loadLiveUsage").mockResolvedValue({ accounts: [], snapshots: [] });
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  createUsageExtension()({
    events: createEventBus(),
    on: () => {},
    registerCommand: (_: string, value: { handler: typeof command }) => {
      command = value.handler;
    },
  } as unknown as ExtensionAPI);
  const pending = command("", {
    hasUI: true,
    mode: "rpc",
    sessionManager: { getSessionId: () => "s" },
    ui: { notify: () => {} },
  } as unknown as ExtensionCommandContext);
  try {
    expect(read).toHaveBeenCalledTimes(1);
    expect(limits).toHaveBeenCalledTimes(1);
  } finally {
    release({ records: [], skipped: 0 });
    await pending;
    read.mockRestore();
    limits.mockRestore();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});

test("standalone native tracking, router attempt attribution, reload dedup and listener teardown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-lifecycle-"));
  try {
    const events = createEventBus();
    const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
    const commands: string[] = [];
    const pi = {
      events,
      on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
        hooks.set(name, handler),
      registerCommand: (name: string) => commands.push(name),
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI: true,
      sessionManager: { getSessionId: () => "session" },
      modelRegistry: {
        find: () => ({}),
        getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
        isUsingOAuth: () => true,
      },
      ui: { notify: () => {} },
    } as unknown as ExtensionContext;
    const usage = {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    };
    const native = {
      role: "assistant",
      provider: "native",
      model: "model",
      api: "openai-completions",
      timestamp: Date.now(),
      stopReason: "stop",
      content: [],
      usage,
    };
    createUsageExtension({ directory })(pi);
    expect(commands).toEqual(["usage"]);
    await hooks.get("session_start")!({} as never, ctx);
    await hooks.get("message_end")!({ message: native } as never, ctx);
    await hooks.get("message_end")!({ message: native } as never, ctx);
    const routed = {
      id: "attempt",
      accountId: "a",
      accountName: "Personal",
      provider: "native",
      model: "model",
      sessionId: "session",
      timestamp: Date.now(),
      usage,
      outcome: "stop",
      subscription: true,
    };
    events.emit("router:usage", routed);
    events.emit("router:usage", { ...routed, id: "api-attempt", subscription: false });
    await hooks.get("message_end")!(
      { message: { ...native } } as never,
      {
        ...ctx,
        modelRegistry: { ...ctx.modelRegistry, isUsingOAuth: () => false },
      } as unknown as ExtensionContext,
    );
    await hooks.get("message_end")!(
      { message: { ...native, provider: "accounts-native" } } as never,
      ctx,
    );
    let loaded = await new UsageLedger(directory).read();
    expect(loaded.records).toHaveLength(2);
    expect(loaded.records.find((r) => r.accountId === "a")?.subscription).toBe(true);
    await hooks.get("session_shutdown")!({} as never, ctx);
    events.emit("router:usage", { ...routed, id: "after-shutdown" });
    createUsageExtension({ directory })(pi);
    await hooks.get("session_start")!({} as never, ctx);
    loaded = await new UsageLedger(directory).read();
    expect(loaded.records).toHaveLength(2);
    events.emit("router:usage", { ...routed, id: "after-reload" });
    loaded = await new UsageLedger(directory).read();
    expect(loaded.records).toHaveLength(3);
    await hooks.get("session_shutdown")!({} as never, ctx);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("command hides old API history without deleting it and presents remaining status first", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-scope-"));
  try {
    const ledger = new UsageLedger(directory);
    for (const subscription of [false, true])
      ledger.append({
        id: String(subscription),
        sessionId: "session",
        accountId: "a",
        accountName: "Account",
        provider: subscription ? "future-subscription" : "api-only",
        model: "model",
        subscription,
        timestamp: Date.now(),
        outcome: "stop",
        usage: {
          input: 10,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        },
      });
    let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const notices: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "rpc",
      sessionManager: { getSessionId: () => "session" },
      ui: { notify: (text: string) => notices.push(text) },
    } as unknown as ExtensionCommandContext;
    const pi = {
      events: createEventBus(),
      on: () => {},
      registerCommand: (_name: string, value: { handler: typeof command }) => {
        command = value.handler;
      },
    } as unknown as ExtensionAPI;
    createUsageExtension({ directory, live: false })(pi);
    await command("", ctx);
    const output = notices.join("\n");
    expect(output).toStartWith("Remaining allowances");
    expect(output).toContain("10 tokens, 1 requests");
    expect(output).not.toContain("api-only");
    expect(output).toContain("future-subscription");
    expect((await ledger.read()).records).toHaveLength(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
