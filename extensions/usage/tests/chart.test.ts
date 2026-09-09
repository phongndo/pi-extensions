import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildTimeline, renderTimeline } from "../chart.ts";
import type { UsageRecord } from "../ledger.ts";
const DAY = 86400_000;
const now = Date.UTC(2026, 8, 8, 17, 15);
const theme = { fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m` } as Theme;
function row(timestamp: number, tokens = 10, cost = 0.01): UsageRecord {
  return {
    version: 1,
    id: String(timestamp),
    sessionId: "session",
    accountId: "account",
    accountName: "Account",
    provider: "test",
    model: "model",
    subscription: false,
    timestamp,
    outcome: "stop",
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  };
}
test("all-time bins cover the entire ledger rather than silently charting only 30 days", () => {
  const first = Date.UTC(2020, 0, 1);
  const records = [row(first, 15), row(now, 25), row(now + 1, 999)];
  const timeline = buildTimeline(records, "all", "tokens", 30, now)!;
  expect(timeline.from).toBe(first);
  expect(timeline.to).toBe(Date.UTC(2026, 8, 9));
  expect(timeline.values.length).toBeLessThanOrEqual(30);
  expect(timeline.values.reduce((a, b) => a + b, 0)).toBe(40);
  expect(timeline.values[0]).toBe(15);
  expect(timeline.values.at(-1)).toBe(25);
  const graph = renderTimeline(records, "all", "tokens", 100, 9, theme, now).join("\n");
  expect(graph).toContain("2020-01-01");
  expect(graph).toContain("2026-09-08");
  expect(graph).toContain("Tokens over time");
  expect(graph).toContain("/bar · UTC");
});
test("calendar windows include quiet days and preserve totals at every display width", () => {
  const from = Date.UTC(2026, 8, 2);
  const records = [row(from - 1, 999), row(from, 10), row(from + 2 * DAY, 20), row(now, 30)];
  const daily = buildTimeline(records, "7d", "tokens", 80, now)!;
  expect(daily.values).toEqual([10, 0, 20, 0, 0, 0, 30]);
  for (const columns of [0, 1, 2, 3, 5, 7, 40]) {
    const timeline = buildTimeline(records, "7d", "tokens", columns, now)!;
    expect(timeline.values.length).toBeLessThanOrEqual(Math.max(1, columns));
    expect(timeline.values.reduce((a, b) => a + b, 0)).toBe(60);
  }
  expect(buildTimeline([row(now)], "30d", "tokens", 80, now)?.values).toHaveLength(30);
});
test("session timeline uses minute/hour bins from the first scoped request, not 30 unrelated days", () => {
  const timeline = buildTimeline([row(now - 2 * 3600000), row(now)], "session", "tokens", 40, now)!;
  expect(timeline.from).toBe(now - 2 * 3600000);
  expect(timeline.step).toBe(4 * 60_000);
  expect(timeline.values.reduce((a, b) => a + b, 0)).toBe(20);
  const graph = renderTimeline(
    [row(now - 2 * 3600000), row(now)],
    "session",
    "tokens",
    100,
    9,
    theme,
    now,
  ).join("\n");
  expect(graph).toContain("09-08 15:15");
  expect(graph).toContain("09-08 17:15");
});
test("cost graphs retain small price equivalents, and empty versus reported zero remains distinct", () => {
  const records = [row(now, 0, 0.000001)];
  expect(buildTimeline(records, "7d", "cost", 80, now)?.values.at(-1)).toBe(0.000001);
  const graph = renderTimeline(records, "7d", "cost", 80, 8, theme, now).join("\n");
  expect(graph).toContain("Price equivalent over time");
  expect(graph).toContain("$1.0e-6");
  expect(buildTimeline([], "all", "tokens", 80, now)).toBeUndefined();
  expect(renderTimeline([], "all", "tokens", 80, 8, theme, now).join("\n")).toContain(
    "No usage recorded yet",
  );
  expect(renderTimeline([row(now, 0, 0)], "all", "tokens", 80, 8, theme, now).join("\n")).toContain(
    "zero reported",
  );
});
test("graphs remain bounded for narrow/short terminals and decades of history", () => {
  const records = [row(0, 100), row(now, 10)];
  expect(buildTimeline(records, "all", "tokens", 1000, now)?.values.length).toBeLessThanOrEqual(
    200,
  );
  for (const width of [1, 20, 30, 40, 80, 120])
    for (const height of [1, 3, 4, 9, 15]) {
      const lines = renderTimeline(records, "all", "tokens", width, height, theme, now);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
});
