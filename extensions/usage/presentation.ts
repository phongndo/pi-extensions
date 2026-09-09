import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CodexSnapshot } from "./codex.ts";
import { fromCodex, type Allowance, type AllowanceSnapshot } from "./allowances.ts";

const PROVIDERS: Record<string, string> = {
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  xai: "Grok",
  firecrawl: "Firecrawl",
  google: "Google",
  "google-gemini-cli": "Gemini CLI",
  "github-copilot": "GitHub Copilot",
  openrouter: "OpenRouter",
  mistral: "Mistral",
  groq: "Groq",
  unknown: "Unattributed",
};
export const providerName = (id: string, names?: ReadonlyMap<string, string>) =>
  names?.get(id) ?? (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id]! : id);
export const estimate = (value: number) =>
  value === 0
    ? "$0"
    : value < 0.01
      ? "<$0.01"
      : new Intl.NumberFormat("en", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(value);
/** Remaining allowance is a percentage of the provider window, never a token or dollar balance. */
export function remainingUsage(used: number): { percent?: number; label: string } {
  if (!Number.isFinite(used) || used < 0) return { label: "Remaining unavailable" };
  const percent = Math.max(0, 100 - used);
  const formatted =
    percent > 0 && percent < 0.01
      ? "<0.01"
      : new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(percent);
  return { percent, label: `${formatted}% remaining` };
}
export function pad(text: string, width: number, right = false): string {
  const fitted = truncateToWidth(text, Math.max(0, width), "…");
  const space = " ".repeat(Math.max(0, width - visibleWidth(fitted)));
  return right ? space + fitted : fitted + space;
}
export function split(left: string, right: string, width: number): string {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 3 ? left + " ".repeat(gap) + right : truncateToWidth(left, width);
}
export interface TableRow {
  label: string;
  tokens: string;
  estimate: string;
  accounts?: string;
}
/** Fixed numeric columns stay aligned; optional columns disappear before names become unreadable. */
export function table(
  rows: TableRow[],
  heading: string,
  width: number,
  room: number,
  theme: Theme,
  selected?: number,
  offset = 0,
): string[] {
  if (room < 2) return [];
  const showCost = width >= 44;
  const showAccounts = width >= 64 && rows.some((r) => r.accounts !== undefined);
  const columns = [
    { key: "tokens" as const, label: "Tokens", width: 9 },
    ...(showCost ? [{ key: "estimate" as const, label: "Price eq.", width: 10 }] : []),
    ...(showAccounts ? [{ key: "accounts" as const, label: "Accounts", width: 8 }] : []),
  ];
  // Account counts precede usage columns, close to the provider they qualify.
  if (showAccounts) columns.unshift(columns.pop()!);
  const labelWidth = Math.max(1, width - 2 - columns.reduce((n, c) => n + c.width + 2, 0));
  const line = (label: string, cells: (string | undefined)[], prefix = "  ") =>
    prefix +
    pad(label, labelWidth) +
    columns.map((c, i) => "  " + pad(cells[i] ?? "—", c.width, true)).join("");
  const showScroll = room >= 3 && rows.length > room - 1;
  const capacity = Math.max(1, room - 1 - Number(showScroll));
  const start =
    selected === undefined
      ? Math.min(offset, Math.max(0, rows.length - capacity))
      : Math.max(0, Math.min(selected - Math.floor(capacity / 2), rows.length - capacity));
  const result = [
    theme.fg(
      "dim",
      line(
        heading,
        columns.map((c) => c.label),
      ),
    ),
  ];
  for (let i = start; i < Math.min(rows.length, start + capacity); i++) {
    const row = rows[i]!;
    const text = line(
      row.label,
      columns.map((c) => row[c.key]),
      selected === i ? "› " : "  ",
    );
    result.push(theme.fg(selected === i ? "accent" : "text", text));
  }
  if (showScroll)
    result.push(
      theme.fg("dim", `  ${start + 1}–${Math.min(rows.length, start + capacity)} / ${rows.length}`),
    );
  return result.map((s) => truncateToWidth(s, width));
}
/** Two useful units, not a full UTC timestamp on every row. */
export function countdown(value?: number, now = Date.now()): string {
  if (value === undefined || !Number.isFinite(value)) return "unknown";
  if (value <= now) return "expired";
  let minutes = Math.floor((value - now) / 60000);
  if (!minutes) return "<1m";
  const parts: string[] = [];
  for (const [size, unit] of [
    [1440, "d"],
    [60, "h"],
    [1, "m"],
  ] as const) {
    const n = Math.floor(minutes / size);
    minutes %= size;
    if (n) parts.push(`${n}${unit}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}
interface DetailRow {
  label: string;
  value: string;
  expires?: string;
}
function resetSummary(s: AllowanceSnapshot, now = Date.now()): DetailRow[] {
  if (s.resetsError) return [{ label: "Banked resets", value: "Unavailable" }];
  if (s.resets === undefined && s.availableResets === undefined) return [];
  const available = (s.resets ?? []).filter((r) => r.status === "available");
  const others = (s.resets ?? []).filter((r) => r.status !== "available");
  return [
    {
      label: "Banked resets",
      value: `${s.availableResets ?? "unknown"} available`,
      expires: available.length
        ? available.map((r) => countdown(r.expiresAt, now)).join(" · ")
        : undefined,
    },
    ...[...new Set(others.map((r) => r.status))].map((status) => {
      const group = others.filter((r) => r.status === status);
      return {
        label: "",
        value: `${group.length} ${status}`,
        expires: group.map((r) => countdown(r.expiresAt, now)).join(" · "),
      };
    }),
  ];
}
export function allowanceLabel(a: Allowance): string {
  if (a.unlimited) return "Unlimited";
  if (a.remaining !== undefined && Number.isFinite(a.remaining) && a.remaining >= 0)
    return `${a.remaining.toLocaleString("en", { maximumFractionDigits: 4 })} ${a.unit ?? "units"} remaining`;
  return remainingUsage(a.remainingPercent === undefined ? NaN : 100 - a.remainingPercent).label;
}
export function liveRows(snapshots: CodexSnapshot[], width: number, theme: Theme): string[] {
  return allowanceRows(snapshots.map(fromCodex), width, theme);
}
/** One aligned limit per line: short bars, inline resets, compact banked-credit countdowns. */
export function allowanceRows(
  snapshots: AllowanceSnapshot[],
  width: number,
  theme: Theme,
  names?: ReadonlyMap<string, string>,
): string[] {
  const rows: string[] = [];
  const now = Date.now();
  // Fixed left-anchored slots: renaming any account/window must not move the data columns.
  const aligned = width >= 64;
  const accountWidth = 12,
    labelWidth = 14,
    valueWidth = 19;
  const valueCell = (value: string) =>
    value + " ".repeat(Math.max(0, valueWidth - visibleWidth(value)));
  const prefix = (account: string, label: string) =>
    aligned
      ? pad(account, accountWidth) + "  " + pad(label, labelWidth) + "  "
      : (account ? account + "  " : "") + (label ? label + "  " : "");
  const add = (text: string, indent = 0) => {
    const inset = Math.min(indent, Math.max(0, width - 1));
    rows.push(
      ...wrapTextWithAnsi(text, Math.max(1, width - inset)).map((line) => " ".repeat(inset) + line),
    );
  };
  for (const provider of [...new Set(snapshots.map((s) => s.account.provider))].sort()) {
    if (rows.length) rows.push("");
    add(theme.fg("accent", theme.bold(providerName(provider, names))));
    const group = snapshots.filter((s) => s.account.provider === provider);
    for (const s of group) {
      if (s.unavailable || !s.allowances.length) {
        const status = s.unavailable
          ? s.unsupported
            ? "Not supported yet"
            : "Unavailable"
          : "Not reported";
        add(`${prefix(theme.fg("text", s.account.name), "")}${theme.fg("muted", status)}`, 2);
      } else
        s.allowances.forEach((a, i) => {
          const knownPercent =
            a.remainingPercent !== undefined &&
            Number.isFinite(a.remainingPercent) &&
            a.remainingPercent >= 0 &&
            a.remainingPercent <= 100;
          const size = width >= 64 ? 12 : width >= 44 ? 8 : 0;
          const filled = knownPercent ? Math.floor((a.remainingPercent! * size) / 100) : 0;
          const color = knownPercent && a.remainingPercent! <= 10 ? "warning" : "accent";
          const bar =
            knownPercent && size
              ? theme.fg(color, "━".repeat(filled)) +
                theme.fg("dim", "─".repeat(size - filled)) +
                "  "
              : "";
          const value = allowanceLabel(a)
            .replace(/ remaining$/, "")
            .replace("Remaining unavailable", "—");
          const balance = theme.fg(
            knownPercent ? color : "text",
            knownPercent ? pad(value, 5, true) : aligned ? valueCell(value) : value,
          );
          const reset =
            a.resetsAt === undefined
              ? ""
              : theme.fg("dim", `  ${a.resetLabel ? "ends" : "↻"} ${countdown(a.resetsAt, now)}`);
          const name = a.shortLabel ?? a.label;
          const account = i === 0 ? theme.fg("text", theme.bold(s.account.name)) : "";
          add(`${prefix(account, name)}${bar}${balance}${reset}`, 2);
        });
      const details = resetSummary(s, now);
      if (s.extraCredits !== undefined && Number(s.extraCredits) !== 0)
        details.push({ label: "Extra credits", value: s.extraCredits });
      for (const row of details) {
        const line = aligned
          ? prefix("", row.label) + valueCell(row.value) + (row.expires ? `  ◷ ${row.expires}` : "")
          : `${row.label ? row.label + "  " : ""}${row.value}${row.expires ? ` · ◷ ${row.expires}` : ""}`;
        add(theme.fg("muted", line), aligned ? 2 : 4);
      }
    }
  }
  return rows;
}
