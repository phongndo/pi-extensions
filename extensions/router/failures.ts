import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

export interface AccountHealth {
  until: number;
  reason: "rate limit" | "quota";
}
type FailureKind =
  | AccountHealth["reason"]
  | "aborted"
  | "auth"
  | "permission"
  | "context"
  | "transient"
  | "request"
  | "unknown";
export interface RequestFailure {
  kind: FailureKind;
  status?: number;
}

/** Missing or inconsistent totals are not proof of an unbilled, replayable attempt. */
export function hasNoUsage(usage: AssistantMessage["usage"]): boolean {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ].every((value) => value === 0);
}

/** Account rotation is deliberately narrower than same-account transient recovery. */
export function limitReason(
  status: number | undefined,
  message: string,
): AccountHealth["reason"] | undefined {
  if (
    status === 401 ||
    status === 403 ||
    /\b(?:401|403|unauthorized|forbidden)\b|invalid_grant|invalid[_ ]token/i.test(message)
  )
    return undefined;
  if (
    /insufficient_quota|quota[_ ]exceeded|usage[_ ]limit(?:[_ ](?:has|have|had|was|were|is|are|been))*[_ ]*reached|GoUsageLimitError|FreeUsageLimitError|out of budget|credit balance is too low|available balance|exceeded your current quota|chatgpt usage limit/i.test(
      message,
    )
  )
    return "quota";
  if (
    status === 429 ||
    /\b429\b|rate[_ -]?limit|too many requests|ResourceExhausted/i.test(message)
  )
    return "rate limit";
  return undefined;
}

export function retryAt(
  value: string | undefined,
  now: number,
  reason: AccountHealth["reason"],
): number {
  const seconds = value?.trim() ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const target = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : date;
  return Number.isFinite(target) && target > now
    ? target
    : now + (reason === "quota" ? 60 * 60_000 : 60_000);
}

/** Classify once, before redaction. Raw provider text must never become a public diagnostic. */
export function classifyFailure(message: AssistantMessage, status?: number): RequestFailure {
  const text = message.errorMessage ?? "";
  const kind = (): FailureKind => {
    if (message.stopReason === "aborted") return "aborted";
    if (
      status === 401 ||
      /\b401\b|unauthorized|invalid_grant|invalid[_ ]token|authentication|not configured|refresh token/i.test(
        text,
      )
    )
      return "auth";
    if (status === 403 || /\b403\b|forbidden|permission denied/i.test(text)) return "permission";
    if (isContextOverflow(message)) return "context";
    const limit = limitReason(status, text);
    if (limit) return limit;
    if (
      status === 408 ||
      (status !== undefined && status >= 500 && status <= 599) ||
      isRetryableAssistantError(message) ||
      /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))\b|(?:network|connection)[ _-]+(?:disconnected|closed|reset)|an error occurred while processing your request/i.test(
        text,
      )
    )
      return "transient";
    if (status !== undefined && status >= 400 && status < 500) return "request";
    return "unknown";
  };
  return { kind: kind(), status };
}

/**
 * These strings are also Pi's retry/compaction protocol. Never append arbitrary text,
 * account labels, or HTTP codes to a replay-blocked error: even "503" triggers retry.
 */
export function failureMessage(failure: RequestFailure, replaySafe: boolean): string {
  if (failure.kind === "aborted") return "Account request cancelled.";
  if (!replaySafe)
    return "Router: account response interrupted after output or usage. Automatic replay blocked to avoid duplicate work or charges.";
  const http =
    failure.status !== undefined &&
    Number.isInteger(failure.status) &&
    failure.status >= 400 &&
    failure.status <= 599
      ? ` (HTTP ${failure.status})`
      : "";
  switch (failure.kind) {
    case "context":
      return "context_length_exceeded: account request exceeds the model context window.";
    case "transient":
      return `Router: transient network error${http}. Pi may retry this request under its configured retry policy; no account rotation.`;
    case "auth":
      return "Router: account authentication failed. Use /login to renew this account; no account rotation.";
    case "permission":
      return "Router: account permission denied. Check this account's model access; no account rotation.";
    case "quota":
    case "rate limit":
      return "Account allowance exhausted. Request stopped; wait for its reset.";
    case "request":
      return `Router: provider rejected the request${http}. Check model/options and conversation compatibility; no automatic replay.`;
    case "unknown":
      return "Router: unclassified provider failure. No automatic replay; check provider configuration or try again manually. Provider details withheld to protect credentials.";
  }
}
