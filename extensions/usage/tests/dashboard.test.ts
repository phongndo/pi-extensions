import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderTimeline } from "../chart.ts";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { UsageDashboard } from "../dashboard.ts";
import type { UsageRecord } from "../ledger.ts";
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as Theme;
test("native-themed dashboard is bounded at narrow widths and short heights", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  for (const width of [1, 20, 40, 80, 120])
    for (const height of [10, 24, 50]) {
      const view = new UsageDashboard(
        [],
        [{ id: "one", name: "Unicode 測試 " + "long".repeat(30), provider: "test", enabled: true }],
        "session",
        theme,
        keys,
        () => {},
        () => height,
      );
      expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(view.render(width).length).toBeLessThanOrEqual(height);
    }
});
test("injected custom keys control period, drilldown and cancellation", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.cancel": "q",
    "tui.select.confirm": "e",
    "tui.input.tab": "p",
  });
  let closed = false;
  const view = new UsageDashboard(
    [],
    [{ id: "a", name: "Personal", provider: "test", enabled: true }],
    "session",
    theme,
    keys,
    () => {
      closed = true;
    },
    () => 30,
  );
  view.handleInput("h");
  view.handleInput("p");
  expect(view.render(100).join("\n")).toContain("[30 days]");
  view.handleInput("m");
  expect(view.render(100).join("\n")).toContain("Accounts");
  view.handleInput("m");
  expect(view.render(100).join("\n")).not.toContain("Personal"); // No model rows exist yet.
  view.handleInput("e");
  view.handleInput("q");
  expect(closed).toBe(false);
  view.handleInput("q");
  expect(closed).toBe(true);
  view.invalidate();
  expect(view.render(80).length).toBeGreaterThan(0);
});
test("overall provider totals drill into only that provider and return to overall", () => {
  const row = (provider: string, tokens: number): UsageRecord => ({
    version: 1,
    id: provider,
    accountId: provider,
    accountName: provider,
    sessionId: "session",
    provider,
    model: "model",
    timestamp: Date.now(),
    subscription: false,
    outcome: "stop",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const view = new UsageDashboard(
    [row("codex", 60), row("anthropic", 40)],
    [],
    "session",
    theme,
    keys,
    () => {},
    () => 30,
  );
  view.handleInput("h");
  expect(view.render(150).join("\n")).toContain("100");
  view.handleInput("\r");
  expect(stripVTControlCharacters(view.render(150).join("\n"))).toContain("Usage / codex");
  expect(view.render(150).join("\n")).toContain("[7 days]");
  expect(view.render(150).join("\n")).not.toContain("anthropic");
  view.handleInput("\u001b");
  expect(view.render(150).join("\n")).toContain("Overall");
  view.handleInput("p");
  expect(stripVTControlCharacters(view.render(150).join("\n"))).toContain("Usage / Anthropic");
});
test("timeline follows overall, provider, account, metric and session filters with current aliases", () => {
  const now = Date.UTC(2026, 8, 8, 12);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const row = (
    accountId: string,
    provider: string,
    timestamp: number,
    tokens: number,
    sessionId = "session",
  ): UsageRecord => ({
    version: 1,
    id: accountId,
    accountId,
    accountName: "Old label",
    provider,
    model: "model",
    sessionId,
    timestamp,
    subscription: false,
    outcome: "stop",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: tokens / 1000, output: 0, cacheRead: 0, cacheWrite: 0, total: tokens / 1000 },
    },
  });
  const records = [
    row("a", "alpha", Date.UTC(2020, 0, 1), 111, "old-session"),
    row("b", "alpha", now, 222),
    row("c", "beta", Date.UTC(2024, 0, 1), 700),
  ];
  try {
    const view = new UsageDashboard(
      records,
      [{ id: "b", name: "Work", provider: "alpha", enabled: true }],
      "session",
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      () => 40,
      "all",
    );
    view.handleInput("h");
    const text = () => stripVTControlCharacters(view.render(150).join("\n"));
    const expected = (
      rows: UsageRecord[],
      period: "all" | "session" = "all",
      metric: "tokens" | "cost" = "tokens",
    ) =>
      stripVTControlCharacters(
        renderTimeline(rows, period, metric, 92, 9, theme, now)
          .map((line) => `  ${line}`)
          .join("\n"),
      );
    expect(text()).toContain(expected(records));
    view.handleInput("p"); // First provider alphabetically, not the largest group.
    expect(text()).toContain("Usage / alpha");
    expect(text()).toContain("[All time]");
    expect(text()).toContain(expected(records.slice(0, 2)));
    expect(text()).toContain("Work");
    view.handleInput("\r");
    expect(text()).toContain("Usage / alpha / Work");
    expect(text()).toContain(expected([records[1]!]));
    view.handleInput("c");
    expect(text()).toContain(expected([records[1]!], "all", "cost"));
    view.handleInput("\t"); // all → session resets account drilldown, retains provider filter.
    expect(text()).toContain(expected([records[1]!], "session", "cost"));
    expect(text()).not.toContain("2020-01-01");
  } finally {
    clock.mockRestore();
  }
});
test("empty dashboard explains missing history instead of drawing unexplained dots", () => {
  const view = new UsageDashboard(
    [],
    [{ id: "a", name: "Personal", provider: "test", enabled: true }],
    "session",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 30,
  );
  view.handleInput("h");
  const text = stripVTControlCharacters(view.render(120).join("\n"));
  expect(text).toContain("No activity in this period");
  expect(text).toContain("New requests appear here automatically");
  for (const clutter of [
    "0 tokens",
    "0 requests",
    "$0.0000",
    "Input 0",
    "subscription equivalent",
    "failed/aborted",
  ])
    expect(text).not.toContain(clutter);
  expect(view.render(120).length).toBeLessThanOrEqual(14);
  expect(text).not.toContain("·······");
});
test("stats stay behind s/details and every panel respects terminal bounds", () => {
  const row: UsageRecord = {
    version: 1,
    id: "r",
    accountId: "a",
    accountName: "Personal",
    provider: "openai-codex",
    model: "model",
    sessionId: "session",
    timestamp: Date.now(),
    subscription: true,
    outcome: "error",
    usage: {
      input: 1200,
      output: 100,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 1360,
      cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
  };
  for (const width of [1, 20, 40, 80, 120])
    for (const height of [6, 10, 24, 50]) {
      const view = new UsageDashboard(
        [row],
        [{ id: "a", name: "Personal", provider: "openai-codex", enabled: true }],
        "session",
        theme,
        new KeybindingsManager(TUI_KEYBINDINGS),
        () => {},
        () => height,
        "7d",
        {
          snapshots: [
            {
              account: {
                id: "a",
                name: "Personal",
                provider: "openai-codex",
                credentialId: "fake",
              },
              checkedAt: 0,
              allowances: [{ label: "Weekly", remainingPercent: 58 }],
              availableResets: 0,
              resets: [],
            },
          ],
        },
      );
      for (const key of ["", "h", "s", "s", "\r", "\r", "?", "\u001b", "b"]) {
        if (key) view.handleInput(key);
        const lines = view.render(width);
        expect(lines.length).toBeLessThanOrEqual(height);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  const view = new UsageDashboard(
    [row],
    [],
    "session",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 40,
  );
  view.handleInput("h");
  const text = () => stripVTControlCharacters(view.render(120).join("\n"));
  expect(text()).not.toContain("Cache read");
  expect(text()).toContain("$0.30 sub. equiv.");
  expect(text()).toContain("1 failed");
  view.handleInput("s");
  expect(text()).toContain("Cache read 50");
  expect(text()).toContain("Subscription price equivalent $0.3000");
  view.handleInput("m");
  expect(text()).toContain("Accounts");
  view.handleInput("m");
  expect(text()).toContain("Models");
});
test("screenshot-shaped empty view stays compact with named providers and no warning wall", () => {
  const accounts = [
    { id: "a", name: "Personal", provider: "openai-codex", enabled: true },
    { id: "b", name: "Work", provider: "openai-codex", enabled: true },
    { id: "c", name: "Test", provider: "xai", enabled: true },
  ];
  const view = new UsageDashboard(
    [],
    accounts,
    "session",
    theme,
    new KeybindingsManager(TUI_KEYBINDINGS),
    () => {},
    () => 40,
    "7d",
    {
      snapshots: [
        {
          account: { id: "a", name: "Personal", provider: "openai-codex", credentialId: "fake" },
          checkedAt: 0,
          allowances: [{ label: "Weekly", remainingPercent: 75 }],
        },
      ],
    },
  );
  const lines = view.render(160);
  const text = stripVTControlCharacters(lines.join("\n"));
  expect(text).toContain("OpenAI Codex");
  expect(text).toContain("Grok");
  expect(text).toContain("Usage / Remaining");
  expect(text).toContain("75%");
  expect(text).toContain("Personal");
  expect(text).toContain("Work");
  expect(text).toContain("Test");
  expect(text).toContain("h history");
  expect(lines.length).toBeLessThanOrEqual(20);
  expect(lines.every((line) => visibleWidth(line) <= 96)).toBe(true);
  for (const clutter of [
    "openai-codex",
    "failed/aborted",
    "Input",
    "$0",
    "OAuth",
    "0 tok",
    "banked resets and expirations",
  ])
    expect(text).not.toContain(clutter);
  view.handleInput("?");
  expect(stripVTControlCharacters(view.render(160).join("\n"))).toContain("Usage / Help");
  expect(view.render(160).join("\n")).toContain("no earlier backfill");
  view.handleInput("\u001b");
  expect(stripVTControlCharacters(view.render(160).join("\n"))).toContain("Usage / Remaining");
});
test("compact reset rows retain every expiry even when the list wraps and scrolls", () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 30));
  try {
    const view = new UsageDashboard(
      [],
      [],
      "session",
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      () => 15,
      "7d",
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
    const displayed: string[] = [];
    for (let n = 0; n < 90; n++) {
      const rows = view.render(200);
      displayed.push(...rows);
      expect(rows.length).toBeLessThanOrEqual(15);
      view.handleInput("\u001b[B");
    }
    for (let n = 1; n <= 30; n++)
      expect(stripVTControlCharacters(displayed.join("\n"))).toMatch(new RegExp(`\\b${n}d\\b`));
    expect(displayed.join("\n")).not.toContain("reset-");
  } finally {
    clock.mockRestore();
  }
});
