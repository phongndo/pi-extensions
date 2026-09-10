import { expect, spyOn, test } from "bun:test";
import {
  createEventBus,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createUsageExtension } from "../index.ts";
import * as live from "../live.ts";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

function harness(options: Parameters<typeof createUsageExtension>[0] = {}) {
  const events = createEventBus();
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const listen = spyOn(events, "on");
  createUsageExtension(options)({
    events,
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerCommand: (_name: string, value: typeof command) => {
      command = value;
    },
  } as unknown as ExtensionAPI);
  return { events, hooks, command, listen };
}

test("command opens cancellable native UI before live limits finish loading", async () => {
  initTheme("dark", false);
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  let release!: (value: Awaited<ReturnType<typeof live.loadLiveUsage>>) => void;
  let requestSignal: AbortSignal | undefined;
  const limits = spyOn(live, "loadLiveUsage").mockImplementation((_ctx, signal) => {
    requestSignal = signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  let opened = false;
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (text: string) => notices.push(text),
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
        component.handleInput?.("\u001b");
        component.dispose?.();
        await closed;
      },
    },
  } as unknown as ExtensionCommandContext;
  const { command, listen } = harness();
  try {
    await command.handler("", ctx);
    expect(opened).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
    expect(notices).toEqual([]);
  } finally {
    release?.({ accounts: [], snapshots: [] });
    limits.mockRestore();
    listen.mockRestore();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});

test("usage does not register native or Router history collectors and tears down listeners", () => {
  const { hooks, listen, command } = harness({ live: false });
  try {
    expect(hooks.has("message_end")).toBe(false);
    expect(hooks.has("session_compact")).toBe(false);
    expect(listen.mock.calls.map(([name]) => name)).toEqual([
      "router:active-account",
      "router:accounts",
    ]);
    expect(command.getArgumentCompletions).toBeUndefined();
    expect(command.description).not.toContain("history");
    hooks.get("session_shutdown")!({} as never, {} as ExtensionContext);
  } finally {
    listen.mockRestore();
  }
});

test("RPC shows only live allowances, supports provider filtering, and rejects obsolete period syntax", async () => {
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  const accounts = [
    { id: "a", name: "Personal", provider: "openai-codex", enabled: true },
    { id: "f", name: "Team", provider: "firecrawl", enabled: true },
  ];
  const limits = spyOn(live, "loadLiveUsage").mockResolvedValue({
    accounts,
    snapshots: accounts.map((account) => ({
      account: { ...account, credentialId: "fake" },
      checkedAt: 0,
      allowances: [{ label: "Weekly", remainingPercent: 75 }],
    })),
  });
  const { command, listen } = harness();
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  try {
    await command.handler("", ctx);
    expect(notices[0]).toStartWith("Remaining allowances");
    expect(notices[0]).toContain("75% remaining");
    expect(notices[0]).not.toMatch(/recorded|tokens|requests|price equivalent/i);
    await command.handler("firecrawl", ctx);
    expect(notices[1]).toContain("Firecrawl");
    expect(notices[1]).not.toContain("Personal");
    await command.handler("30d anthropic", ctx);
    expect(notices[2]).toBe("Usage: /usage [provider]");
    expect(limits).toHaveBeenCalledTimes(2);
    await command.handler("session", ctx);
    expect(notices[3]).toContain("No stored login or allowance status for provider session");
    limits.mockRejectedValue(new Error("secret provider response"));
    await command.handler("", ctx);
    expect(notices[4]).toContain("Live limits unavailable");
    expect(notices[4]).not.toMatch(/secret|local totals/);
  } finally {
    limits.mockRestore();
    listen.mockRestore();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});
