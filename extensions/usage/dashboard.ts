import {
  BorderedLoader,
  DynamicBorder,
  type Theme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { UsageRecord } from "./ledger.ts";
import type { CodexSnapshot } from "./codex.ts";
import type { AllowanceSnapshot } from "./allowances.ts";
import {
  breakdown,
  count,
  money,
  periodRecords,
  totals,
  type AccountInfo,
  type Period,
} from "./model.ts";
import { renderTimeline } from "./chart.ts";
import {
  estimate,
  allowanceRows,
  allowanceLabel,
  providerName,
  remainingUsage,
  split,
  table,
  type TableRow,
} from "./presentation.ts";

export interface DashboardOptions {
  provider?: string;
  providerNames?: ReadonlyMap<string, string>;
  snapshots?: AllowanceSnapshot[];
  liveError?: string;
}
const date = (value?: number) =>
  value === undefined
    ? "unknown"
    : new Date(value).toISOString().replace("T", " ").replace(".000Z", " UTC");
/** Full plain-text counterpart for RPC clients. */
export function codexLines(snapshots: CodexSnapshot[]): string[] {
  return snapshots.flatMap((s) => [
    `${s.account.name} · ${s.plan ?? "Codex"} · checked ${date(s.checkedAt)}`,
    ...(s.usageError
      ? [s.usageError]
      : s.windows?.length
        ? s.windows.map(
            (w) =>
              `  ${w.label}: ${remainingUsage(w.usedPercent).label} · resets ${date(w.resetsAt)}`,
          )
        : ["  Usage windows not reported"]),
    ...(s.creditBalance === undefined
      ? []
      : [`  Purchased/extra credit balance: ${s.creditBalance} (not banked resets)`]),
    ...(s.resetsError
      ? [s.resetsError]
      : [
          `  Banked resets: ${s.availableResets ?? "unknown"} available · ${s.resets?.length ?? 0} returned`,
          ...(s.resets ?? []).flatMap((r) => [
            `  [${r.status}] ${r.title}`,
            `    expires ${date(r.expiresAt)} · ${r.id}`,
          ]),
        ]),
    "",
  ]);
}
function scopedSnapshots(accounts: AccountInfo[], options: DashboardOptions): AllowanceSnapshot[] {
  const snapshots = [...(options.snapshots ?? [])];
  for (const a of accounts) {
    if (!a.enabled || snapshots.some((s) => s.account.id === a.id)) continue;
    snapshots.push({
      account: { ...a, credentialId: a.credentialId ?? "" },
      checkedAt: 0,
      allowances: [],
      unavailable: options.liveError ?? "Remaining allowance unavailable",
    });
  }
  return snapshots.filter((s) => !options.provider || s.account.provider === options.provider);
}
export function allowanceLines(snapshots: AllowanceSnapshot[]): string[] {
  return [...new Set(snapshots.map((s) => s.account.provider))]
    .sort()
    .flatMap((provider) => [
      providerName(provider),
      ...snapshots
        .filter((s) => s.account.provider === provider)
        .flatMap((s) => [
          `  ${s.account.name}${s.plan ? ` · ${s.plan}` : ""} · checked ${s.checkedAt ? date(s.checkedAt) : "not checked"}`,
          ...(s.unavailable
            ? [`    ${s.unavailable}`]
            : s.allowances.length
              ? s.allowances.map(
                  (a) =>
                    `    ${a.label}: ${allowanceLabel(a)}${a.resetsAt === undefined ? "" : ` · ${a.resetLabel ?? "resets"} ${date(a.resetsAt)}`}`,
                )
              : ["    Remaining allowance not reported"]),
          ...(s.extraCredits === undefined
            ? []
            : [`    Extra credits: ${s.extraCredits} (not banked resets)`]),
          ...(s.resetsError
            ? [`    ${s.resetsError}`]
            : s.resets !== undefined || s.availableResets !== undefined
              ? [
                  `    Banked resets: ${s.availableResets ?? "unknown"} available`,
                  ...(s.resets ?? []).map(
                    (r) => `    [${r.status}] ${r.title} · expires ${date(r.expiresAt)} · ${r.id}`,
                  ),
                ]
              : []),
        ]),
    ]);
}
const PERIODS: Period[] = ["session", "7d", "30d", "all"];
const PERIOD_LABELS = { session: "Session", "7d": "7 days", "30d": "30 days", all: "All time" };
type Group = ReturnType<typeof breakdown>[number];

export class UsageDashboard implements Component {
  private period: Period;
  private by: "provider" | "account" | "model" = "provider";
  private metric: "tokens" | "cost" = "tokens";
  private selected = 0;
  private detail = false;
  private live = true;
  private help = false;
  private stats = false;
  private scroll = 0;
  private provider?: string;
  private records: UsageRecord[];
  private accounts: AccountInfo[];
  private sessionId: string;
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: () => void;
  private height: () => number;
  private options: DashboardOptions;
  constructor(
    records: UsageRecord[],
    accounts: AccountInfo[],
    sessionId: string,
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    height: () => number,
    period: Period = "7d",
    options: DashboardOptions = {},
  ) {
    this.records = records;
    this.accounts = accounts;
    this.sessionId = sessionId;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.height = height;
    this.options = options;
    this.period = period;
    this.provider = options.provider;
    if (this.provider) this.by = "account";
  }
  private name(id: string) {
    return providerName(id, this.options.providerNames);
  }
  private providers() {
    return [
      ...new Set([
        ...this.records.map((r) => r.provider),
        ...this.accounts.map((a) => a.provider),
        ...(this.options.snapshots ?? []).map((s) => s.account.provider),
      ]),
    ].sort();
  }
  private snapshots(): AllowanceSnapshot[] {
    return scopedSnapshots(this.accounts, this.options);
  }
  private filtered() {
    return periodRecords(this.records, this.period, this.sessionId).filter(
      (r) => !this.provider || r.provider === this.provider,
    );
  }
  private groups() {
    return breakdown(
      this.filtered(),
      this.by,
      this.accounts.filter((a) => !this.provider || a.provider === this.provider),
    );
  }
  private reset() {
    this.selected = 0;
    this.detail = false;
    this.scroll = 0;
  }
  private key(id: Parameters<KeybindingsManager["getKeys"]>[0]) {
    return this.keys.getKeys(id).join("/");
  }
  invalidate(): void {}
  handleInput(data: string): void {
    // Configured Pi keys take precedence over this panel's letter shortcuts.
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.help) this.help = false;
      else if (this.live) this.done();
      else if (this.detail) this.detail = false;
      else if (this.provider) {
        this.provider = undefined;
        this.by = "provider";
        this.reset();
      } else this.done();
      this.scroll = 0;
    } else if (this.keys.matches(data, "tui.input.tab")) {
      this.period = PERIODS[(PERIODS.indexOf(this.period) + 1) % PERIODS.length]!;
      this.reset();
    } else if (
      this.keys.matches(data, "tui.select.up") ||
      this.keys.matches(data, "tui.select.pageUp")
    ) {
      const step = this.keys.matches(data, "tui.select.pageUp") ? 5 : 1;
      if (this.live || this.help || this.detail) this.scroll = Math.max(0, this.scroll - step);
      else this.selected = Math.max(0, this.selected - step);
    } else if (
      this.keys.matches(data, "tui.select.down") ||
      this.keys.matches(data, "tui.select.pageDown")
    ) {
      const step = this.keys.matches(data, "tui.select.pageDown") ? 5 : 1;
      if (this.live || this.help || this.detail) this.scroll += step;
      else this.selected = Math.min(Math.max(0, this.groups().length - 1), this.selected + step);
    } else if (this.keys.matches(data, "tui.select.confirm")) {
      if (this.live || this.help) return;
      const group = this.groups()[this.selected];
      if (this.by === "provider" && group) {
        this.provider = group.key;
        this.by = "account";
        this.reset();
      } else {
        this.detail = !this.detail;
        this.scroll = 0;
      }
    } else if (matchesKey(data, "p")) {
      const providers = [undefined, ...this.providers()];
      this.provider = providers[(providers.indexOf(this.provider) + 1) % providers.length];
      this.by = this.provider ? "account" : "provider";
      this.reset();
    } else if (matchesKey(data, "b") || matchesKey(data, "h")) {
      this.live = !this.live;
      this.scroll = 0;
    } else if (matchesKey(data, "m")) {
      const modes = ["provider", "account", "model"] as const;
      this.by = modes[(modes.indexOf(this.by) + 1) % modes.length]!;
      this.reset();
    } else if (matchesKey(data, "c")) this.metric = this.metric === "tokens" ? "cost" : "tokens";
    else if (matchesKey(data, "s")) this.stats = !this.stats;
    else if (matchesKey(data, "?")) {
      this.help = !this.help;
      this.scroll = 0;
    }
  }
  private label(group: Group, by = this.by): string {
    if (by === "provider") return this.name(group.key);
    if (by === "model")
      return this.provider ? group.key.slice(group.key.indexOf("/") + 1) : group.key;
    const account = this.accounts.find((a) => a.id === group.key);
    const name = account?.name ?? group.records[0]?.accountName ?? group.label;
    const provider = account?.provider ?? group.records[0]?.provider;
    return name + (!this.provider && provider ? ` · ${this.name(provider)}` : "");
  }
  private rows(groups: Group[], by = this.by): TableRow[] {
    return groups.map((g) => ({
      label: this.label(g, by),
      tokens: g.totals.requests ? count(g.totals.tokens) : "—",
      estimate: g.totals.requests ? estimate(g.totals.subscriptionEquivalent) : "—",
      accounts:
        by === "provider"
          ? String(this.accounts.filter((a) => a.provider === g.key && a.enabled).length || "—")
          : undefined,
    }));
  }
  private scrollRows(rows: string[], room: number): string[] {
    const capacity = Math.max(1, room - (rows.length > room && room > 1 ? 1 : 0));
    this.scroll = Math.min(this.scroll, Math.max(0, rows.length - capacity));
    return [
      ...rows.slice(this.scroll, this.scroll + capacity),
      ...(rows.length > room && room > 1
        ? [
            this.theme.fg(
              "dim",
              `${this.scroll + 1}–${Math.min(rows.length, this.scroll + capacity)} / ${rows.length} · ${this.key("tui.select.up")}/${this.key("tui.select.down")} scroll`,
            ),
          ]
        : []),
    ];
  }
  private helpRows(): string[] {
    const t = this.theme;
    return [
      t.bold("Navigation"),
      `${this.key("tui.input.tab")}  Change period`,
      `${this.key("tui.select.up")}/${this.key("tui.select.down")}  Select or scroll`,
      `${this.key("tui.select.confirm")}  Open provider / account / model details`,
      `${this.key("tui.select.cancel")}  Back / close`,
      "",
      t.bold("Views"),
      "p  Cycle provider / overall",
      "m  Group by provider / account / model",
      "c  Graph tokens / price equivalent",
      "s  Token, cache and cost details",
      "h / b  Remaining allowances ↔ recorded history",
      "?  Close help",
      "",
      t.fg("muted", "Local history starts when Usage is loaded; no earlier backfill."),
      t.fg("muted", "Subscription price equivalents are estimates, not charges."),
      t.fg("muted", "Bars show remaining allowance; ↻ window reset; ◷ banked-credit expiry."),
      t.fg("muted", "Allowances are read-only snapshots. No resets are consumed."),
      t.fg("muted", "Reopen /usage to refresh. Missing or unsupported limits stay unavailable."),
      t.fg("muted", "Only Pi OAuth subscriptions and Firecrawl team credits are included."),
      t.fg("muted", "Native compactions without billing attribution are not counted."),
    ];
  }
  render(width: number): string[] {
    if (width <= 0 || this.height() <= 0) return [];
    const t = this.theme;
    // Native borders follow Pi's supplied width; keep only the content comfortably bounded.
    const panelWidth = width;
    const inner = Math.max(1, Math.min(96, width) - 4);
    const height = Math.max(1, this.height() - 2);
    const history = !this.live && !this.help;
    const groups = history ? this.groups() : [];
    if (history) this.selected = Math.max(0, Math.min(this.selected, groups.length - 1));
    const group = groups[this.selected];
    const records = history ? (this.detail && group ? group.records : this.filtered()) : [];
    const sum = totals(records);
    const scope = this.provider ? this.name(this.provider) : "Overall";
    const title = this.help
      ? "Help"
      : this.live
        ? "Remaining" + (this.provider ? ` / ${scope}` : "")
        : scope + (this.detail && group ? ` / ${this.label(group)}` : "");
    const heading = split(
      t.bold("Usage") + t.fg("dim", " / ") + t.fg("accent", title),
      this.live && !this.help ? "" : t.fg("dim", "Local · estimates"),
      inner,
    );
    const tabs =
      this.live || this.help
        ? []
        : [
            PERIODS.map((p) =>
              p === this.period
                ? t.fg("accent", t.bold(`[${PERIOD_LABELS[p]}]`))
                : t.fg("dim", ` ${PERIOD_LABELS[p]} `),
            ).join("  "),
          ];
    const navigation = this.help
      ? `? back  ·  ${this.key("tui.select.cancel")} close help`
      : this.live
        ? `h history  ·  ? help  ·  ${this.keys.getKeys("tui.select.cancel")[0]} close`
        : `${this.key("tui.input.tab")} period  ·  ${this.key("tui.select.confirm")} ${this.detail ? "back" : "open"}  ·  h remaining  ·  ? help  ·  ${this.key("tui.select.cancel")} back`;
    const border = new DynamicBorder((s: string) => t.fg("borderMuted", s)).render(panelWidth);
    const header = [heading, ...tabs];
    const bodyRoom = Math.max(0, height - border.length * 2 - header.length - 3);
    let body: string[] = [];
    if (this.help) body = this.scrollRows(this.helpRows(), bodyRoom);
    else if (this.live) {
      const snapshots = this.snapshots();
      let rows = allowanceRows(snapshots, inner, t, this.options.providerNames);
      if (!rows.length)
        rows = [
          t.fg(
            "muted",
            this.options.liveError ?? "No signed-in subscriptions or Firecrawl key. Use /login.",
          ),
        ];
      body = this.scrollRows(rows, bodyRoom);
    } else {
      if (records.length) {
        const summary = [
          t.bold(count(sum.tokens)) + t.fg("muted", " tokens"),
          t.bold(count(sum.requests)) + t.fg("muted", " requests"),
        ];
        if (sum.subscriptionEquivalent)
          summary.push(estimate(sum.subscriptionEquivalent) + t.fg("muted", " sub. equiv."));
        if (sum.unattributedEstimate)
          summary.push(estimate(sum.unattributedEstimate) + t.fg("muted", " unattributed"));
        if (sum.errors) summary.push(t.fg("warning", `${sum.errors} failed`));
        body.push(summary.join("    "), "");
        if (this.stats || this.detail) {
          body.push(
            t.fg(
              "muted",
              `Input ${count(sum.input)}  ·  Output ${count(sum.output)}  ·  Failed/aborted ${sum.errors}`,
            ),
            t.fg(
              "muted",
              `Cache read ${count(sum.cacheRead)}  ·  Cache write ${count(sum.cacheWrite)}`,
            ),
            t.fg("muted", `Subscription price equivalent ${money(sum.subscriptionEquivalent)}`),
          );
          if (sum.unattributedEstimate)
            body.push(t.fg("muted", `Unattributed estimate ${money(sum.unattributedEstimate)}`));
          body.push("");
        }
        const reserve = groups.length ? 4 : 0;
        const chartRoom = Math.max(0, Math.min(9, bodyRoom - body.length - reserve));
        body.push(...renderTimeline(records, this.period, this.metric, inner, chartRoom, t));
      } else {
        body.push(
          t.fg("text", "No activity in this period"),
          t.fg(
            "dim",
            this.records.length
              ? "Try a different period or provider."
              : "New requests appear here automatically.",
          ),
        );
      }
      if (groups.length && bodyRoom - body.length >= 3) {
        body.push("");
        let children = groups;
        let by = this.by;
        if (this.detail && group) {
          by = this.by === "account" ? "model" : "account";
          const ids = new Set(group.records.map((r) => r.accountId));
          children = breakdown(
            group.records,
            by,
            this.accounts.filter((a) => ids.has(a.id)),
          );
        }
        body.push(
          ...table(
            this.rows(children, by),
            `${by[0]!.toUpperCase()}${by.slice(1)}s`,
            inner,
            Math.min(9, bodyRoom - body.length),
            t,
            this.detail ? undefined : this.selected,
            this.scroll,
          ),
        );
      }
    }
    const lines = [
      ...border,
      ...header.map((s) => `  ${s}`),
      "",
      ...body.slice(0, bodyRoom).map((s) => `  ${s}`),
      "",
      `  ${t.fg("dim", navigation)}`,
      ...border,
    ];
    // Preserve the closing border even when the terminal cannot fit the normal chrome.
    const fitted = lines.length > height ? [...lines.slice(0, height - 1), ...border] : lines;
    return fitted.map((line) => truncateToWidth(line, panelWidth));
  }
}
/** Show Pi's native loader immediately; cancellation never waits for an uncooperative read. */
export async function loadWithUsageUI<T>(
  ctx: ExtensionContext,
  lifetime: AbortSignal,
  load: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  if (ctx.mode !== "tui") return load(lifetime);
  type Result = { value: T } | { error: unknown } | undefined;
  const result = await ctx.ui.custom<Result>((tui, theme, keys, done) => {
    const loader = new BorderedLoader(tui, theme, "Loading usage…");
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal, loader.signal]);
    let settled = false;
    const finish = (result: Result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      controller.abort();
      loader.dispose();
      done(result);
    };
    const cancel = () => finish(undefined);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
    else
      void load(signal).then(
        (value) => finish({ value }),
        (error) => finish({ error }),
      );
    return {
      signal,
      render: (width) => loader.render(width),
      invalidate: () => loader.invalidate(),
      handleInput: (data) => {
        if (keys.matches(data, "tui.select.cancel")) controller.abort();
      },
      dispose: () => {
        signal.removeEventListener("abort", cancel);
        settled = true;
        controller.abort();
        loader.dispose();
      },
    };
  });
  if (result && "error" in result) throw result.error;
  return result?.value;
}

export async function showDashboard(
  ctx: ExtensionContext,
  records: UsageRecord[],
  accounts: AccountInfo[],
  period: Period,
  options: DashboardOptions = {},
): Promise<void> {
  if (ctx.mode !== "tui") {
    const filtered = periodRecords(records, period, ctx.sessionManager.getSessionId()).filter(
      (r) => !options.provider || r.provider === options.provider,
    );
    const sum = totals(filtered);
    ctx.ui.notify(
      [
        "Remaining allowances",
        ...allowanceLines(scopedSnapshots(accounts, options)),
        ...(options.liveError ? [options.liveError] : []),
        `Recorded subscription usage (${options.provider ?? "Overall"}, ${period}): ${count(sum.tokens)} tokens, ${sum.requests} requests. Subscription price equivalent ${money(sum.subscriptionEquivalent)}. Recorded Pi usage only; not bills.`,
        ...breakdown(filtered, "provider").map(
          (g) =>
            `${g.label}: ${count(g.totals.tokens)} tokens · ${money(g.totals.subscriptionEquivalent)} price equivalent`,
        ),
      ].join("\n"),
      "info",
    );
    return;
  }
  const providerNames = new Map(options.providerNames);
  for (const id of new Set([
    ...records.map((r) => r.provider),
    ...accounts.map((a) => a.provider),
  ])) {
    const name = ctx.modelRegistry.getProvider(id)?.name;
    if (name) providerNames.set(id, name);
  }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const dashboard = new UsageDashboard(
      records,
      accounts,
      ctx.sessionManager.getSessionId(),
      theme,
      keys,
      () => done(),
      () => tui.terminal.rows,
      period,
      { ...options, providerNames },
    );
    return {
      render: (w) => dashboard.render(w),
      invalidate: () => dashboard.invalidate(),
      handleInput: (data) => {
        dashboard.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
