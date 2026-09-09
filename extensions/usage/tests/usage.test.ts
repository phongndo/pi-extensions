import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsageLedger, usageRecord, type UsageRecord } from "../ledger.ts";
import { breakdown, daily, periodRecords, sparkline, totals } from "../model.ts";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
export function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    version: 1,
    id: "one",
    sessionId: "session",
    accountId: "account",
    accountName: "Personal",
    provider: "test",
    model: "model",
    subscription: false,
    timestamp: Date.UTC(2026, 0, 10, 12),
    outcome: "stop",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 20,
      cost: { input: 0.1, output: 0.05, cacheRead: 0.01, cacheWrite: 0.02, total: 0.18 },
    },
    ...overrides,
  };
}
test("durable independent shards, deduplication, permissions and corrupted line recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
  dirs.push(directory);
  const first = new UsageLedger(directory);
  const second = new UsageLedger(directory);
  expect(first.append(record())).toBe(true);
  expect(first.append(record())).toBe(false);
  second.append(record());
  second.append(record({ id: "two", subscription: true }));
  expect(readdirSync(directory)).toHaveLength(2);
  const file = join(directory, readdirSync(directory)[0]!);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  appendFileSync(file, "{incomplete\n");
  const loaded = await new UsageLedger(directory).read();
  expect(loaded.records).toHaveLength(2);
  expect(loaded.skipped).toBe(1);
  const sum = totals(loaded.records);
  expect(sum.tokens).toBe(40);
  expect(sum.apiEstimate).toBe(0.18);
  expect(sum.subscriptionEquivalent).toBe(0.18);
});
test("only allowlisted numeric usage and metadata are serialized", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-private-"));
  dirs.push(directory);
  new UsageLedger(directory).append({
    ...record(),
    apiKey: "SECRET",
    content: "PRIVATE PROMPT",
    errorMessage: "RAW ERROR",
    headers: { authorization: "TOKEN" },
  });
  const raw = readFileSync(join(directory, readdirSync(directory)[0]!), "utf8");
  for (const secret of ["SECRET", "PRIVATE PROMPT", "RAW ERROR", "TOKEN"])
    expect(raw).not.toContain(secret);
  expect(usageRecord(record({ usage: { ...record().usage, input: NaN } }))).toBeUndefined();
  expect(usageRecord(record({ accountName: "bad\x1b[31m" }))).toBeUndefined();
});
test("periods and UTC buckets include empty days without including future events", () => {
  const now = Date.UTC(2026, 0, 10, 12);
  const rows = [
    record(),
    record({ id: "old", timestamp: now - 9 * 86400_000 }),
    record({ id: "other-session", sessionId: "other" }),
    record({ id: "future", timestamp: now + 86400_000 }),
  ];
  expect(periodRecords(rows, "session", "session", now).map((r) => r.id)).toEqual(["one", "old"]);
  expect(periodRecords(rows, "7d", "session", now)).toHaveLength(2);
  expect(periodRecords(rows, "30d", "session", now)).toHaveLength(3);
  expect(daily(rows, 3, now)).toEqual([0, 0, 40]);
  expect(sparkline([0, 1, 8])).toBe("·▁█");
  expect(sparkline([0, 0])).toBe("··");
});
test("breakdowns preserve zero-use accounts and separate same model id across providers", () => {
  const rows = [record(), record({ id: "two", provider: "different" })];
  const grouped = breakdown(rows, "account", [
    { id: "empty", name: "Backup", provider: "test", enabled: false },
  ]);
  expect(grouped.find((g) => g.key === "empty")?.totals.tokens).toBe(0);
  expect(breakdown(rows, "model")).toHaveLength(2);
});
test("empty ledger is a valid zero state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-usage-empty-"));
  dirs.push(directory);
  expect(await new UsageLedger(join(directory, "missing")).read()).toEqual({
    records: [],
    skipped: 0,
  });
});
