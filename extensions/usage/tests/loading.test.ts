import { expect, test } from "bun:test";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import { loadWithUsageUI } from "../dashboard.ts";

function harness() {
  initTheme("dark", false);
  let component!: Component & { dispose?: () => void };
  let closes = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise((resolve) => {
          const result = factory(
            { requestRender: () => {} } as Parameters<typeof factory>[0],
            { fg: (_: string, s: string) => s } as Parameters<typeof factory>[1],
            new KeybindingsManager(TUI_KEYBINDINGS, {
              "tui.select.cancel": "q",
            }) as Parameters<typeof factory>[2],
            (value) => {
              closes++;
              resolve(value);
            },
          );
          component = result as typeof component;
        }),
    },
  } as unknown as ExtensionContext;
  return { ctx, component: () => component, closes: () => closes };
}

test("native loading UI returns results and propagates failures", async () => {
  const h = harness();
  const lifetime = new AbortController();
  expect(await loadWithUsageUI(h.ctx, lifetime.signal, async () => 42)).toBe(42);
  expect(h.closes()).toBe(1);
  await expect(
    loadWithUsageUI(h.ctx, lifetime.signal, async () => {
      throw new Error("history failed");
    }),
  ).rejects.toThrow("history failed");
  expect(h.closes()).toBe(2);
  h.component().dispose?.();
});

for (const kind of ["key", "shutdown"] as const) {
  test(`${kind} cancels immediately and ignores late loading completion`, async () => {
    const h = harness();
    const lifetime = new AbortController();
    let signal!: AbortSignal;
    let release!: (value: number) => void;
    const pending = loadWithUsageUI(h.ctx, lifetime.signal, (s) => {
      signal = s;
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    if (kind === "key") h.component().handleInput?.("q");
    else lifetime.abort();
    expect(await pending).toBeUndefined();
    expect(signal.aborted).toBe(true);
    h.component().dispose?.();
    release(42);
    await Promise.resolve();
    expect(h.closes()).toBe(1);
  });
}

test("disposing the UI aborts its work without closing a newer UI", async () => {
  const h = harness();
  let signal!: AbortSignal;
  let reject!: (error: Error) => void;
  void loadWithUsageUI(h.ctx, new AbortController().signal, (s) => {
    signal = s;
    return new Promise((_, fail) => {
      reject = fail;
    });
  });
  h.component().dispose?.();
  expect(signal.aborted).toBe(true);
  reject(new Error("late cancellation"));
  await Promise.resolve();
  expect(h.closes()).toBe(0);
});
