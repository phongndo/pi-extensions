import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { UsageDashboard } from "../dashboard.ts";
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as Theme;
const accounts = [
  { id: "a", name: "Personal", provider: "openai-codex", enabled: true },
  { id: "b", name: "Work", provider: "openai-codex", enabled: true },
  { id: "c", name: "Test", provider: "xai", enabled: true },
];
const text = (view: UsageDashboard) => stripVTControlCharacters(view.render(160).join("\n"));

test("native borders and content stay bounded across resizes and help", () => {
  let height = 40;
  const view = new UsageDashboard(
    accounts,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => height,
  );
  for (const key of ["", "?"]) {
    if (key) view.handleInput(key);
    for (const width of [170, 80, 24, 120, 1, 200]) {
      for (height of [40, 12, 8]) {
        view.invalidate();
        const lines = view.render(width);
        expect(visibleWidth(lines[0]!)).toBe(width);
        expect(stripVTControlCharacters(lines.at(-1)!)).toBe("─".repeat(width));
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(height - 2);
      }
    }
  }
});

test("remaining allowances are the only view; old history shortcuts do nothing", () => {
  const view = new UsageDashboard(
    accounts,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 40,
    {
      snapshots: [
        {
          account: { ...accounts[0]!, credentialId: "fake" },
          checkedAt: 0,
          allowances: [{ label: "Weekly", remainingPercent: 75 }],
        },
      ],
    },
  );
  const initial = text(view);
  for (const label of [
    "OpenAI Codex",
    "Grok",
    "Usage / Remaining",
    "75%",
    "Personal",
    "Work",
    "Test",
    "p provider",
  ])
    expect(initial).toContain(label);
  for (const key of ["h", "b", "m", "c", "s", "\t", "\r"]) {
    view.handleInput(key);
    expect(text(view)).toBe(initial);
  }
  expect(initial).not.toContain("history");
  expect(view.render(160).length).toBeLessThanOrEqual(20);
  view.handleInput("?");
  expect(text(view)).toContain("Usage / Help");
  expect(text(view)).not.toMatch(/history|period|tokens|price equivalent/i);
  view.handleInput("\u001b");
  expect(text(view)).toBe(initial);
});

test("provider cycling filters live snapshots and returns to overall", () => {
  const view = new UsageDashboard(
    accounts,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 40,
  );
  view.handleInput("p");
  expect(text(view)).toContain("Remaining / OpenAI Codex");
  expect(text(view)).toContain("Personal");
  expect(text(view)).not.toContain("Grok");
  view.handleInput("p");
  expect(text(view)).toContain("Remaining / Grok");
  expect(text(view)).not.toContain("Personal");
  view.handleInput("p");
  expect(text(view)).toContain("Personal");
  expect(text(view)).toContain("Grok");
});

test("injected cancel key takes precedence over provider shortcut", () => {
  let closed = false;
  const view = new UsageDashboard(
    accounts,
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "p" }),
    () => {
      closed = true;
    },
    () => 40,
  );
  view.handleInput("?");
  view.handleInput("p");
  expect(closed).toBe(false);
  expect(text(view)).toContain("Usage / Remaining");
  view.handleInput("p");
  expect(closed).toBe(true);
});

test("empty dashboard explains missing logins", () => {
  const view = new UsageDashboard(
    [],
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 30,
  );
  expect(text(view)).toContain("No signed-in subscriptions or Firecrawl key. Use /login.");
});

test("compact reset rows retain every expiry while scrolling with configured keys", () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 30));
  try {
    const view = new UsageDashboard(
      [],
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.up": "k" }),
      () => {},
      () => 15,
      {
        snapshots: [
          {
            account: {
              id: "a",
              name: "Account 1",
              provider: "openai-codex",
              credentialId: "openai-codex",
            },
            checkedAt: 1800000000000,
            allowances: [],
            availableResets: 30,
            resets: Array.from({ length: 30 }, (_, n) => ({
              id: `reset-${n}`,
              title: `Promotion ${n}`,
              status: "available",
              expiresAt: Date.UTC(2026, 9, n + 1),
            })),
          },
        ],
      },
    );
    const initial = view.render(200);
    const displayed: string[] = [];
    for (let n = 0; n < 90; n++) {
      const rows = view.render(200);
      displayed.push(...rows);
      expect(rows.length).toBeLessThanOrEqual(15);
      view.handleInput("j");
    }
    for (let n = 1; n <= 30; n++)
      expect(stripVTControlCharacters(displayed.join("\n"))).toMatch(new RegExp(`\\b${n}d\\b`));
    expect(displayed.join("\n")).not.toContain("reset-");
    for (let n = 0; n < 90; n++) view.handleInput("k");
    expect(view.render(200)).toEqual(initial);
  } finally {
    clock.mockRestore();
  }
});
