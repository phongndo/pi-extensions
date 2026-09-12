import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RequestFailure } from "./failures.ts";

export const DIAGNOSTIC_ENTRY = "router:failure";
export const DIAGNOSTIC_LIMIT = 10;
export const DIAGNOSTIC_HINT = " Upstream details: /router errors.";
const REDACTED = "<REDACTED>";
const MAX_TEXT = 2000;

export interface RouterDiagnostic {
  timestamp: number;
  provider: string;
  model: string;
  accountId?: string;
  stage: "routing" | "request";
  category: RequestFailure["kind"] | "routing";
  status?: number;
  replaySafe: boolean;
  upstream: string;
}

/** Collect only authentication values, never request bodies or conversation context. */
export function diagnosticSecrets(...sources: unknown[]): string[] {
  const values = new Set<string>();
  const visit = (value: unknown, sensitive = false, depth = 0): void => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (sensitive && value) values.add(value);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // Options can contain callbacks, but we never invoke them or inspect their closures.
      if (typeof child === "function") continue;
      visit(
        child,
        sensitive ||
          /^(?:access|refresh|.*token|api[_-]?key|secret|password|authorization|cookie|headers)$/i.test(
            key,
          ),
        depth + 1,
      );
    }
  };
  for (const source of sources) visit(source);
  return [...values];
}

/** Best-effort redaction of untrusted provider text, BEFORE bounding the displayed text. */
export function sanitizeDiagnostic(text: string, secrets: readonly string[] = []): string {
  // Do not cut an unredacted credential in half and accidentally retain its prefix.
  if (text.length > 32_768) return "[Oversized upstream error omitted]";
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    for (const value of new Set([
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ])) {
      if (value.length < 4) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text = text.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"), REDACTED);
      } else text = text.split(value).join(REDACTED);
    }
  }
  // Drop terminal escapes and controls before matching labels (including OSC links).
  // oxlint-disable-next-line no-control-regex -- Deliberately strip terminal escape sequences.
  text = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // oxlint-disable-next-line no-control-regex -- Untrusted provider diagnostics must not control the terminal.
  text = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  text = text
    .replace(/https?:\/\/[^\s<>"']+/gi, "<URL REDACTED>")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, REDACTED)
    .replace(
      /((?:["']?)(?:authorization|proxy-authorization|(?:set-)?cookie)(?:["']?)\s*[:=])[^\r\n]*/gi,
      `$1 ${REDACTED}`,
    )
    .replace(
      /(["']?(?:access(?:[_-]?token)?|refresh(?:[_-]?token)?|id[_-]?token|api[_-]?key|token|password|secret|client_secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?)\b/g, REDACTED)
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(/[A-Za-z0-9_+/=-]{40,}/g, REDACTED);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 14)} …[truncated]` : text;
}

/** Read error messages/codes/causes only, not stack traces, HTTP bodies, or attached configs. */
export function upstreamDiagnostic(cause: unknown, secrets: readonly string[] = []): string {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  for (let depth = 0; cause !== undefined && depth < 4 && !seen.has(cause); depth++) {
    seen.add(cause);
    if (typeof cause === "string") {
      lines.push(cause);
      break;
    }
    if (!cause || typeof cause !== "object") break;
    const error = cause as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    const message = typeof error.message === "string" ? error.message : "";
    const name = typeof error.name === "string" && error.name !== "Error" ? `[${error.name}] ` : "";
    const status =
      typeof error.status === "number" &&
      Number.isInteger(error.status) &&
      error.status >= 100 &&
      error.status <= 599
        ? `[HTTP ${error.status}] `
        : "";
    const code = typeof error.code === "string" ? `[${error.code}] ` : "";
    if (message || code || status || name) lines.push(`${name}${status}${code}${message}`);
    cause = error.cause;
  }
  return sanitizeDiagnostic(
    lines.join("\nCaused by: ") || "No upstream error details supplied.",
    secrets,
  );
}

export function sessionDiagnostics(entries: readonly SessionEntry[]): RouterDiagnostic[] {
  const records: RouterDiagnostic[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== DIAGNOSTIC_ENTRY) continue;
    const d = entry.data as Partial<RouterDiagnostic> | undefined;
    if (
      !d ||
      typeof d.timestamp !== "number" ||
      !Number.isFinite(d.timestamp) ||
      typeof d.provider !== "string" ||
      typeof d.model !== "string" ||
      typeof d.upstream !== "string" ||
      typeof d.category !== "string" ||
      typeof d.replaySafe !== "boolean" ||
      (d.stage !== "request" && d.stage !== "routing")
    )
      continue;
    records.push({
      timestamp: d.timestamp,
      provider: sanitizeDiagnostic(d.provider),
      model: sanitizeDiagnostic(d.model),
      accountId: typeof d.accountId === "string" ? sanitizeDiagnostic(d.accountId) : undefined,
      stage: d.stage,
      category: d.category,
      replaySafe: d.replaySafe,
      status:
        Number.isInteger(d.status) && d.status! >= 100 && d.status! <= 599 ? d.status : undefined,
      upstream: sanitizeDiagnostic(d.upstream),
    });
    if (records.length > DIAGNOSTIC_LIMIT) records.shift();
  }
  return records;
}

/** Human-only output: never put these strings in AssistantMessage.errorMessage or LLM context. */
export function formatDiagnostics(records: readonly RouterDiagnostic[]): string {
  if (!records.length) return "No router failures recorded on this session branch.";
  return records
    .slice(-DIAGNOSTIC_LIMIT)
    .reverse()
    .map((d) => {
      const time = new Date(d.timestamp);
      const timestamp = Number.isNaN(time.getTime()) ? "unknown time" : time.toISOString();
      return (
        `${timestamp} · ${sanitizeDiagnostic(d.provider)}/${sanitizeDiagnostic(d.model)}\n` +
        `${d.stage} · ${sanitizeDiagnostic(d.category)}${d.status ? ` · HTTP ${d.status}` : ""}` +
        `${d.accountId ? ` · account ${sanitizeDiagnostic(d.accountId)}` : ""} · replay ${d.replaySafe ? "safe" : "blocked"}\n` +
        sanitizeDiagnostic(d.upstream)
      );
    })
    .join("\n\n");
}
