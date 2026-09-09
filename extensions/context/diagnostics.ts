import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const EVENT_TYPE = "context.event";
export const IMPLEMENTATION_VERSION = "0.7.0";

/** New writes require exactly the fields meaningful for each observation. */
export type DiagnosticEvent =
  | { event: "compaction"; outcome: "normal" | "other"; compactionId: string; tokensBefore: number }
  | { event: "post_compaction_usage"; compactionId: string; inputTokens: number }
  | { event: "compaction_failed"; reason: "host_rejected" }
  | { event: "cancelled"; reason: "compaction_aborted" };
export type Diagnostic = { version: 1; implementation: string } & DiagnosticEvent;

/** A validated projection of current and retired records, never a write contract. */
interface HistoricalDiagnostic {
  version: 1;
  implementation: string;
  mode?: string;
  event: string;
  outcome?: "normal" | "other" | "fresh";
  reason?: string;
  compactionId?: string;
  tokensBefore?: number;
  inputTokens?: number;
}

export const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(value);
const EVENTS = new Set([
  "activation",
  "reminder",
  "reset_requested",
  "compaction",
  "compaction_failed",
  "cancelled",
  "resumed",
  "post_reset_usage",
  "post_compaction_usage",
]);

function parse(value: unknown): HistoricalDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    !identifier(data.implementation) ||
    typeof data.event !== "string" ||
    !EVENTS.has(data.event)
  )
    return;
  if (data.compactionId !== undefined && !identifier(data.compactionId)) return;
  if (data.tokensBefore !== undefined && !isTokenCount(data.tokensBefore)) return;
  if (data.inputTokens !== undefined && !isTokenCount(data.inputTokens)) return;
  const outcome = data.outcome;
  if (outcome !== undefined && outcome !== "normal" && outcome !== "other" && outcome !== "fresh")
    return;
  if (
    data.event === "compaction" &&
    (!identifier(data.compactionId) || outcome === undefined || !isTokenCount(data.tokensBefore))
  )
    return;
  if (
    ["post_compaction_usage", "post_reset_usage"].includes(data.event) &&
    (!identifier(data.compactionId) || !isTokenCount(data.inputTokens))
  )
    return;
  // Project only known metadata. Never spread persisted data into diagnostics output.
  return {
    version: 1,
    implementation: data.implementation,
    event: data.event,
    ...(identifier(data.mode) ? { mode: data.mode } : {}),
    ...(identifier(data.reason) ? { reason: data.reason } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(identifier(data.compactionId) ? { compactionId: data.compactionId } : {}),
    ...(isTokenCount(data.tokensBefore) ? { tokensBefore: data.tokensBefore } : {}),
    ...(isTokenCount(data.inputTokens) ? { inputTokens: data.inputTokens } : {}),
  };
}

/** Only validated aggregate metadata; raw errors, messages and credentials are excluded. */
export function diagnostics(branch: readonly SessionEntry[]): HistoricalDiagnostic[] {
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== EVENT_TYPE) return [];
    const data = parse(entry.data);
    return data ? [data] : [];
  });
}

const measured = (event: HistoricalDiagnostic, id: string | undefined) =>
  id !== undefined &&
  ["post_compaction_usage", "post_reset_usage"].includes(event.event) &&
  event.compactionId === id;

/**
 * Reconstruct unsaved observations from authoritative ancestry, not event payloads or clocks.
 * The latest compaction supersedes earlier ones even if its diagnostic write failed.
 * Its first successful persisted response is immutable across retries, reload and navigation.
 */
export function pendingDiagnostics(branch: readonly SessionEntry[]): DiagnosticEvent[] {
  let boundaryIndex = branch.length - 1;
  while (boundaryIndex >= 0 && branch[boundaryIndex]!.type !== "compaction") boundaryIndex--;
  const boundary = branch[boundaryIndex];
  if (boundary?.type !== "compaction" || !isTokenCount(boundary.tokensBefore)) return [];
  const events = diagnostics(branch.slice(boundaryIndex + 1));
  const pending: DiagnosticEvent[] = [];
  if (!events.some((event) => event.event === "compaction" && event.compactionId === boundary.id))
    pending.push({
      event: "compaction",
      compactionId: boundary.id,
      outcome: boundary.fromHook ? "other" : "normal",
      tokensBefore: boundary.tokensBefore,
    });
  if (events.some((event) => measured(event, boundary.id))) return pending;

  for (let i = boundaryIndex + 1; i < branch.length; i++) {
    const entry = branch[i]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message;
    if (!["stop", "length", "toolUse"].includes(message.stopReason)) continue;
    const usage = message.usage;
    // An invalid first measurement is unavailable, not permission to use a later request.
    if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite].every(isTokenCount)) break;
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (isTokenCount(inputTokens))
      pending.push({ event: "post_compaction_usage", compactionId: boundary.id, inputTokens });
    break;
  }
  return pending;
}

export function diagnosticStatus(branch: readonly SessionEntry[]): string {
  const events = diagnostics(branch);
  const compact = events.filter((event) => event.event === "compaction").at(-1);
  if (!compact) return "No recorded compaction outcome on this branch.";
  const usage = events.find((event) => measured(event, compact.compactionId));
  return `Last compaction: ${compact.outcome}${usage ? `; next successful request input ${usage.inputTokens} tokens` : ""}.`;
}
