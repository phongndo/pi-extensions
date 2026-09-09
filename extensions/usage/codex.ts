import { safeLabel } from "./ledger.ts";
import { jsonResponse } from "./http.ts";

export interface CodexAccount {
  id: string;
  name: string;
  credentialId: string;
}
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt?: number;
}
export interface BankedReset {
  id: string;
  title: string;
  status: string;
  expiresAt?: number;
  grantedAt?: number;
}
export interface CodexSnapshot {
  account: CodexAccount;
  checkedAt: number;
  plan?: string;
  windows?: UsageWindow[];
  creditBalance?: string;
  resets?: BankedReset[];
  availableResets?: number;
  usageError?: string;
  resetsError?: string;
}
const BASE = "https://chatgpt.com/backend-api/wham/";
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? safeLabel(value).slice(0, 200) : fallback;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function timestamp(value: unknown): number | undefined {
  const n = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === 18000) return "5-hour";
  if (seconds === 604800) return "Weekly";
  return seconds ? `${seconds / 3600}h` : fallback;
}
export function parseCodexUsage(
  value: unknown,
): Pick<CodexSnapshot, "plan" | "windows" | "creditBalance"> {
  const data = object(value);
  if (typeof data.plan_type !== "string" && !("rate_limit" in data))
    throw new Error("Unknown usage response");
  const windows: UsageWindow[] = [];
  const add = (raw: unknown, prefix = "") => {
    const limit = object(raw);
    for (const [field, fallback] of [
      ["primary_window", "Primary"],
      ["secondary_window", "Secondary"],
    ]) {
      const w = object(limit[field!]);
      const used = number(w.used_percent);
      if (used === undefined) continue;
      const reset = number(w.reset_at);
      windows.push({
        label: `${prefix}${windowLabel(number(w.limit_window_seconds), fallback!)}`,
        usedPercent: used,
        resetsAt:
          reset !== undefined && reset * 1000 <= 8640000000000000 ? reset * 1000 : undefined,
      });
    }
  };
  add(data.rate_limit);
  add(data.code_review_rate_limit, "Code review · ");
  if (Array.isArray(data.additional_rate_limits))
    for (const item of data.additional_rate_limits) {
      const limit = object(item);
      add(limit.rate_limit, `${text(limit.limit_name, "Additional")} · `);
    }
  const credits = object(data.credits);
  const balance =
    typeof credits.balance === "string" || typeof credits.balance === "number"
      ? String(credits.balance)
      : undefined;
  return {
    plan: text(data.plan_type, "Unknown plan"),
    windows,
    creditBalance:
      credits.unlimited === true ? "Unlimited" : balance ? text(balance, "Unknown") : undefined,
  };
}
export function parseBankedResets(
  value: unknown,
): Pick<CodexSnapshot, "resets" | "availableResets"> {
  const data = object(value);
  const count = number(data.available_count);
  if (!Array.isArray(data.credits) || count === undefined || !Number.isInteger(count))
    throw new Error("Unknown reset response");
  const resets = data.credits.map((raw): BankedReset => {
    const credit = object(raw);
    if (
      typeof credit.id !== "string" ||
      typeof credit.status !== "string" ||
      typeof credit.reset_type !== "string"
    )
      throw new Error("Invalid reset entry");
    if (credit.expires_at != null && timestamp(credit.expires_at) === undefined)
      throw new Error("Invalid reset expiration");
    return {
      id: text(credit.id, "Unknown"),
      title: text(credit.title, text(credit.reset_type, "Reset")),
      status: text(credit.status, "Unknown"),
      expiresAt: timestamp(credit.expires_at),
      grantedAt: timestamp(credit.granted_at),
    };
  });
  return { resets, availableResets: count };
}

/** Read the same account claim as Pi's Codex adapter. This is not JWT verification. */
export function codexAccountId(token: string): string | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload || payload.length > 32768) return;
    const data = object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const id = object(data["https://api.openai.com/auth"]).chatgpt_account_id;
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : undefined;
  } catch {
    return;
  }
}
/** GET-only, official-host-only reader. No reset consumption, credits purchase, or reserve opt-in. */
export async function readCodexSnapshot(
  account: CodexAccount,
  resolveToken: () => Promise<string | undefined>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<CodexSnapshot> {
  const snapshot: CodexSnapshot = { account, checkedAt: Date.now() };
  try {
    signal.throwIfAborted();
    const token = await resolveToken();
    signal.throwIfAborted();
    const accountId = token ? codexAccountId(token) : undefined;
    if (!token || !accountId) throw new Error("Missing auth");
    const get = async (path: "usage" | "rate-limit-reset-credits") => {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      return jsonResponse(
        await fetcher(BASE + path, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": accountId,
            Accept: "application/json",
          },
        }),
        requestSignal,
      );
    };
    const [usage, resets] = await Promise.allSettled([
      get("usage").then(parseCodexUsage),
      get("rate-limit-reset-credits").then(parseBankedResets),
    ]);
    if (usage.status === "fulfilled") Object.assign(snapshot, usage.value);
    else snapshot.usageError = "Live usage unavailable";
    if (resets.status === "fulfilled") Object.assign(snapshot, resets.value);
    else snapshot.resetsError = "Banked resets unavailable";
  } catch {
    snapshot.usageError = "Live usage unavailable; check /login";
    snapshot.resetsError = "Banked resets unavailable";
  }
  return snapshot;
}
