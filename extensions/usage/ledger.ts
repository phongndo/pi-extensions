import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Usage } from "@earendil-works/pi-ai";

export interface UsageRecord {
  version: 1;
  id: string;
  sessionId: string;
  accountId: string;
  accountName: string;
  provider: string;
  model: string;
  subscription: boolean;
  timestamp: number;
  usage: Usage;
  outcome: string;
}
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export const safeLabel = (text: string): string =>
  Array.from(text)
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && (code < 127 || code > 159);
    })
    .join("");
const clean = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 300 && safeLabel(v) === v;
/** Allowlist serialization: never persist prompts, response content, raw errors, headers, or auth. */
export function usageRecord(value: unknown): UsageRecord | undefined {
  const v = value as UsageRecord;
  if (
    !v ||
    ![v.id, v.sessionId, v.accountId, v.accountName, v.provider, v.model, v.outcome].every(clean) ||
    !finite(v.timestamp) ||
    typeof v.subscription !== "boolean"
  )
    return;
  const u = v.usage;
  if (
    !u ||
    ![
      u.input,
      u.output,
      u.cacheRead,
      u.cacheWrite,
      u.totalTokens,
      u.cost?.input,
      u.cost?.output,
      u.cost?.cacheRead,
      u.cost?.cacheWrite,
      u.cost?.total,
    ].every(finite)
  )
    return;
  return {
    version: 1,
    id: v.id,
    sessionId: v.sessionId,
    accountId: v.accountId,
    accountName: v.accountName,
    provider: v.provider,
    model: v.model,
    subscription: v.subscription,
    timestamp: v.timestamp,
    outcome: v.outcome,
    usage: {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      totalTokens: u.totalTokens,
      cost: {
        input: u.cost.input,
        output: u.cost.output,
        cacheRead: u.cost.cacheRead,
        cacheWrite: u.cost.cacheWrite,
        total: u.cost.total,
      },
    },
  };
}

/** A private append-only shard per extension lifetime: concurrent Pi processes never rewrite totals. */
export class UsageLedger {
  private directory: string;
  private shard = randomUUID();
  private seen = new Set<string>();
  constructor(directory: string) {
    this.directory = directory;
  }
  append(value: unknown): boolean {
    const row = usageRecord(value);
    if (!row || this.seen.has(row.id)) return false;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const day = new Date(row.timestamp).toISOString().slice(0, 10);
    appendFileSync(join(this.directory, `${day}-${this.shard}.jsonl`), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
    this.seen.add(row.id);
    return true;
  }
  async read(signal?: AbortSignal): Promise<{ records: UsageRecord[]; skipped: number }> {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], skipped: 0 };
      throw error;
    }
    const rows = new Map<string, UsageRecord>();
    let skipped = 0;
    for (const name of names.sort()) {
      signal?.throwIfAborted();
      if (!/^\d{4}-\d{2}-\d{2}-[a-f0-9-]+\.jsonl$/.test(name)) continue;
      const stream = createReadStream(join(this.directory, name), { encoding: "utf8", signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const row = parsed.version === 1 ? usageRecord(parsed) : undefined;
            if (row) rows.set(row.id, row);
            else skipped++;
          } catch {
            skipped++;
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    return { records: [...rows.values()], skipped };
  }
}
