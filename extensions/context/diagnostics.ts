import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextMode } from "./state.ts";

export const EVENT_TYPE = "context.event";
export const IMPLEMENTATION_VERSION = "0.4.0";
export type DiagnosticEvent =
  | "activation"
  | "reminder"
  | "reset_requested"
  | "compaction"
  | "compaction_failed"
  | "cancelled"
  | "resumed"
  | "post_reset_usage";
export interface Diagnostic {
  version: 1;
  implementation: string;
  mode?: ContextMode;
  event: DiagnosticEvent;
  enabled?: boolean;
  outcome?: "fresh" | "normal" | "other";
  reason?: string;
  checkpointId?: string;
  compactionId?: string;
  tokensBefore?: number;
  inputTokens?: number;
}

/** Only aggregate metadata; raw errors, messages, queries and credentials never belong here. */
export function diagnostics(branch: readonly SessionEntry[]): Diagnostic[] {
  return branch.flatMap((entry) => {
    if (entry.type !== "custom" || entry.customType !== EVENT_TYPE) return [];
    const data = entry.data as Partial<Diagnostic> | undefined;
    return data?.version === 1 && typeof data.event === "string" ? [data as Diagnostic] : [];
  });
}

/** Reconstruct the unmeasured boundary after reload/navigation, never across sibling branches. */
export function pendingUsage(branch: readonly SessionEntry[]): string | undefined {
  const events = diagnostics(branch);
  const latest = branch.filter((entry) => entry.type === "compaction").at(-1);
  if (
    !latest ||
    !events.some((event) => event.event === "compaction" && event.compactionId === latest.id)
  )
    return undefined;
  return events.some(
    (event) => event.event === "post_reset_usage" && event.compactionId === latest.id,
  )
    ? undefined
    : latest.id;
}

export function diagnosticStatus(branch: readonly SessionEntry[]): string {
  const events = diagnostics(branch);
  const compact = events.filter((event) => event.event === "compaction").at(-1);
  if (!compact) return "No recorded compaction outcome on this branch.";
  const measured = events.find(
    (event) => event.event === "post_reset_usage" && event.compactionId === compact.compactionId,
  );
  return `Last compaction: ${compact.outcome} (${compact.reason ?? "unknown"})${measured ? `; next successful request input ${measured.inputTokens} tokens` : ""}.`;
}
