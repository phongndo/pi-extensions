import type { UsageRecord } from "./ledger.ts";
export type Period = "session" | "7d" | "30d" | "all";
export interface AccountInfo {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  credentialId?: string;
  type?: "oauth" | "api_key";
}
export interface Totals {
  requests: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tokens: number;
  apiEstimate: number;
  subscriptionEquivalent: number;
  unattributedEstimate: number;
}
export const emptyTotals = (): Totals => ({
  requests: 0,
  errors: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  tokens: 0,
  apiEstimate: 0,
  subscriptionEquivalent: 0,
  unattributedEstimate: 0,
});
export function totals(records: UsageRecord[]): Totals {
  return records.reduce((t, r) => {
    t.requests++;
    t.errors += Number(r.outcome === "error" || r.outcome === "aborted");
    t.input += r.usage.input;
    t.output += r.usage.output;
    t.cacheRead += r.usage.cacheRead;
    t.cacheWrite += r.usage.cacheWrite;
    t.tokens += r.usage.totalTokens;
    if (r.provider === "unknown") t.unattributedEstimate += r.usage.cost.total;
    else if (r.subscription) t.subscriptionEquivalent += r.usage.cost.total;
    else t.apiEstimate += r.usage.cost.total;
    return t;
  }, emptyTotals());
}
export function periodRecords(
  records: UsageRecord[],
  period: Period,
  sessionId: string,
  now = Date.now(),
): UsageRecord[] {
  const since = (Math.floor(now / 86400_000) - (period === "7d" ? 6 : 29)) * 86400_000;
  return records.filter(
    (r) =>
      r.timestamp <= now &&
      (period === "session" ? r.sessionId === sessionId : period === "all" || r.timestamp >= since),
  );
}
export function breakdown(
  records: UsageRecord[],
  by: "account" | "model" | "provider",
  accounts: AccountInfo[] = [],
) {
  const groups = new Map<string, { key: string; label: string; records: UsageRecord[] }>();
  if (by !== "model")
    for (const a of accounts) {
      const key = by === "provider" ? a.provider : a.id;
      groups.set(key, {
        key,
        label:
          by === "provider"
            ? a.provider
            : `${a.name} · ${a.provider}${a.enabled ? "" : " (disabled)"}`,
        records: [],
      });
    }
  for (const row of records) {
    const key =
      by === "provider"
        ? row.provider
        : by === "account"
          ? row.accountId
          : `${row.provider}/${row.model}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: by === "account" ? `${row.accountName} · ${row.provider}` : key,
        records: [],
      };
      groups.set(key, group);
    }
    group.records.push(row);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, totals: totals(g.records) }))
    .sort((a, b) => b.totals.tokens - a.totals.tokens || a.label.localeCompare(b.label));
}
/** Fixed UTC calendar-day buckets, including quiet days. */
export function daily(
  records: UsageRecord[],
  days: number,
  now = Date.now(),
  metric: "tokens" | "cost" = "tokens",
): number[] {
  const today = Math.floor(now / 86400_000);
  const buckets = Array.from({ length: days }, () => 0);
  for (const r of records) {
    const index = Math.floor(r.timestamp / 86400_000) - today + days - 1;
    if (index >= 0 && index < days)
      buckets[index]! += metric === "tokens" ? r.usage.totalTokens : r.usage.cost.total;
  }
  return buckets;
}
export function sparkline(values: number[]): string {
  const max = Math.max(0, ...values);
  return values
    .map((v) => (v <= 0 || !max ? "·" : "▁▂▃▄▅▆▇█"[Math.max(0, Math.ceil((v / max) * 8) - 1)]))
    .join("");
}
export function count(n: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
export function money(n: number): string {
  return `$${n.toFixed(4)}`;
}
