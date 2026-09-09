import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createUsageExtension } from "../index.ts";
import { UsageLedger } from "../ledger.ts";

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
