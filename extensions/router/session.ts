import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SESSION_ACCOUNT_ENTRY = "router:session-account";

/** Rebuild preferences from the active branch, including entries before compaction. */
export function sessionAccounts(entries: readonly SessionEntry[]): Map<string, string> {
  const preferences = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ACCOUNT_ENTRY) continue;
    const data = entry.data as { provider?: unknown; accountId?: unknown } | undefined;
    if (!data || typeof data.provider !== "string" || !data.provider) continue;
    if (data.accountId === null) preferences.delete(data.provider);
    else if (typeof data.accountId === "string" && data.accountId)
      preferences.set(data.provider, data.accountId);
  }
  return preferences;
}
