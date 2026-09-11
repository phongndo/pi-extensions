import type { NativeAccount } from "../../src/account-identity.ts";
import { readCodexSnapshot, type BankedReset, type CodexSnapshot } from "./codex.ts";
import { getStatus } from "./http.ts";

export interface Allowance {
  label: string;
  shortLabel?: string;
  remainingPercent?: number;
  remaining?: number;
  unit?: string;
  unlimited?: boolean;
  resetsAt?: number;
  resetLabel?: string;
}
/** Provider-independent, ephemeral status. Missing fields mean unknown, never zero. */
export interface AllowanceSnapshot {
  account: Pick<NativeAccount, "id" | "name" | "provider" | "credentialId">;
  checkedAt: number;
  plan?: string;
  allowances: Allowance[];
  unavailable?: string;
  unsupported?: boolean;
  extraCredits?: string;
  resets?: BankedReset[];
  availableResets?: number;
  resetsError?: string;
}
export interface AllowanceAdapter {
  read(
    account: AllowanceSnapshot["account"],
    resolveToken: () => Promise<string | undefined>,
    signal: AbortSignal,
    fetcher: typeof fetch,
  ): Promise<AllowanceSnapshot>;
}
export function fromCodex(snapshot: CodexSnapshot): AllowanceSnapshot {
  return {
    account: { ...snapshot.account, provider: "openai-codex" },
    checkedAt: snapshot.checkedAt,
    plan: snapshot.plan,
    allowances: (snapshot.windows ?? []).map((w) => ({
      label: w.label,
      shortLabel: w.label
        .replace(/^GPT-[\d.]+-Codex-/i, "")
        .replaceAll(" · ", " ")
        .replaceAll("5-hour", "5h"),
      remainingPercent:
        Number.isFinite(w.usedPercent) && w.usedPercent >= 0
          ? Math.max(0, 100 - w.usedPercent)
          : undefined,
      resetsAt: w.resetsAt,
    })),
    unavailable: snapshot.usageError,
    extraCredits: snapshot.creditBalance,
    resets: snapshot.resets,
    availableResets: snapshot.availableResets,
    resetsError: snapshot.resetsError,
  };
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const number = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const date = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
export function parseFirecrawlUsage(value: unknown): Allowance[] {
  const data = object(value);
  const usage = object(data.data);
  const remaining = number(usage.remainingCredits);
  if (data.success !== true || remaining === undefined) throw new Error("Unknown credit response");
  // Credits can include top-ups; planCredits is not necessarily the denominator of this balance.
  return [
    {
      label: "Team credits",
      shortLabel: "",
      remaining,
      unit: "credits",
      resetsAt: date(usage.billingPeriodEnd),
      resetLabel: "Billing period ends",
    },
  ];
}
/** CodexBar's bearer billing path. Missing percentages are unknown, not unused quota. */
export function parseGrokUsage(value: unknown): Allowance[] {
  const response = object(value);
  if (!response.config || typeof response.config !== "object" || Array.isArray(response.config))
    throw new Error("Unknown Grok billing response");
  const config = object(response.config);
  const used = number(config.creditUsagePercent);
  const resetsAt = date(object(config.currentPeriod).end) ?? date(config.billingPeriodEnd);
  if (used === undefined && resetsAt === undefined) throw new Error("Grok allowance not reported");
  // onDemandUsed/onDemandCap describe a separate spending cap, not subscription allowance.
  return [
    {
      label: "Credits",
      remainingPercent: used === undefined ? undefined : Math.max(0, 100 - used),
      resetsAt,
    },
  ];
}
/** Go reports used percentages, not dollar balances or request counts. */
export function parseOpenCodeGoUsage(value: unknown): Allowance[] {
  const usage = object(object(value).usage);
  const windows = [
    ["rolling", "5h"],
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
  ] as const;
  if (!windows.some(([key]) => key in usage)) throw new Error("Unknown Go usage response");
  return windows.map(([key, label]) => {
    const window = object(usage[key]);
    const used = number(window.percent);
    return {
      label,
      remainingPercent: used === undefined ? undefined : Math.max(0, 100 - used),
      resetsAt: date(window.resetsAt),
    };
  });
}
export const allowanceAdapters: ReadonlyMap<string, AllowanceAdapter> = new Map([
  [
    "openai-codex",
    {
      read: async (account, token, signal, fetcher) =>
        fromCodex(await readCodexSnapshot(account, token, signal, fetcher)),
    },
  ],
  [
    "opencode-go",
    {
      read: async (account, resolveToken, signal, fetcher) => {
        const token = await resolveToken();
        if (!token) throw new Error("Missing auth");
        return {
          account,
          checkedAt: Date.now(),
          allowances: parseOpenCodeGoUsage(
            await getStatus("https://opencode.ai/zen/go/v1/usage", token, signal, fetcher),
          ),
        };
      },
    },
  ],
  [
    "firecrawl",
    {
      read: async (account, resolveToken, signal, fetcher) => {
        const token = await resolveToken();
        if (!token) throw new Error("Missing auth");
        return {
          account,
          checkedAt: Date.now(),
          allowances: parseFirecrawlUsage(
            await getStatus(
              "https://api.firecrawl.dev/v2/team/credit-usage",
              token,
              signal,
              fetcher,
            ),
          ),
        };
      },
    },
  ],
  [
    "xai",
    {
      read: async (account, resolveToken, signal, fetcher) => {
        const token = await resolveToken();
        if (!token) throw new Error("Missing auth");
        return {
          account,
          checkedAt: Date.now(),
          allowances: parseGrokUsage(
            await getStatus(
              "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
              token,
              signal,
              fetcher,
              { "x-xai-token-auth": "xai-grok-cli" },
            ),
          ),
        };
      },
    },
  ],
]);

/** A single seam for new providers; native subscription discovery does not depend on this registry. */
export async function readAllowance(
  account: AllowanceSnapshot["account"],
  resolveToken: () => Promise<string | undefined>,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  adapters: ReadonlyMap<string, AllowanceAdapter> = allowanceAdapters,
): Promise<AllowanceSnapshot> {
  const empty = { account, checkedAt: Date.now(), allowances: [] };
  const adapter = adapters.get(account.provider);
  if (!adapter)
    return {
      ...empty,
      checkedAt: 0,
      unavailable: "Remaining allowance not supported yet",
      unsupported: true,
    };
  try {
    signal.throwIfAborted();
    return await adapter.read(account, resolveToken, signal, fetcher);
  } catch {
    return { ...empty, unavailable: "Remaining allowance unavailable; check /login" };
  }
}
