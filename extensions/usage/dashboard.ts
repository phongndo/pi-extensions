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
import type { CodexSnapshot } from "./codex.ts";
import type { AllowanceSnapshot } from "./allowances.ts";
import type { AccountInfo } from "./model.ts";
import { allowanceRows, allowanceLabel, providerName, remainingUsage } from "./presentation.ts";

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

export class UsageDashboard implements Component {
  private help = false;
  private scroll = 0;
  private provider?: string;
  private accounts: AccountInfo[];
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: () => void;
  private height: () => number;
  private options: DashboardOptions;
  constructor(
    accounts: AccountInfo[],
    theme: Theme,
    keys: KeybindingsManager,
    done: () => void,
    height: () => number,
    options: DashboardOptions = {},
  ) {
    this.accounts = accounts;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.height = height;
    this.options = options;
    this.provider = options.provider;
  }
  private providers() {
    return [
      ...new Set([
        ...this.accounts.map((a) => a.provider),
        ...(this.options.snapshots ?? []).map((s) => s.account.provider),
      ]),
    ].sort();
  }
  private key(id: Parameters<KeybindingsManager["getKeys"]>[0]) {
    return this.keys.getKeys(id).join("/");
  }
  invalidate(): void {}
  handleInput(data: string): void {
    // Configured Pi keys take precedence over this panel's letter shortcuts.
    if (this.keys.matches(data, "tui.select.cancel")) {
      if (this.help) this.help = false;
      else this.done();
      this.scroll = 0;
    } else if (
      this.keys.matches(data, "tui.select.up") ||
      this.keys.matches(data, "tui.select.pageUp")
    ) {
      this.scroll = Math.max(
        0,
        this.scroll - (this.keys.matches(data, "tui.select.pageUp") ? 5 : 1),
      );
    } else if (
      this.keys.matches(data, "tui.select.down") ||
      this.keys.matches(data, "tui.select.pageDown")
    ) {
      this.scroll += this.keys.matches(data, "tui.select.pageDown") ? 5 : 1;
    } else if (matchesKey(data, "p")) {
      const providers = [undefined, ...this.providers()];
      this.provider = providers[(providers.indexOf(this.provider) + 1) % providers.length];
      this.scroll = 0;
    } else if (matchesKey(data, "?")) {
      this.help = !this.help;
      this.scroll = 0;
    }
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
      `${this.key("tui.select.up")}/${this.key("tui.select.down")}  Scroll`,
      `${this.key("tui.select.pageUp")}/${this.key("tui.select.pageDown")}  Scroll page`,
      `${this.key("tui.select.cancel")}  Back / close`,
      "p  Cycle provider / overall",
      "?  Close help",
      "",
      t.fg("muted", "Bars show remaining allowance; ↻ window reset; ◷ banked-credit expiry."),
      t.fg("muted", "Allowances are read-only snapshots. No resets are consumed."),
      t.fg("muted", "Reopen /usage to refresh. Missing or unsupported limits stay unavailable."),
      t.fg("muted", "Only Pi OAuth subscriptions and Firecrawl team credits are included."),
    ];
  }
  render(width: number): string[] {
    if (width <= 0 || this.height() <= 0) return [];
    const t = this.theme;
    const inner = Math.max(1, Math.min(96, width) - 4);
    const height = Math.max(1, this.height() - 2);
    const title = this.help
      ? "Help"
      : "Remaining" +
        (this.provider ? ` / ${providerName(this.provider, this.options.providerNames)}` : "");
    const heading = t.bold("Usage") + t.fg("dim", " / ") + t.fg("accent", title);
    const navigation = this.help
      ? `? back  ·  ${this.key("tui.select.cancel")} close help`
      : `p provider  ·  ? help  ·  ${this.key("tui.select.cancel")} close`;
    const border = new DynamicBorder((s: string) => t.fg("borderMuted", s)).render(width);
    const bodyRoom = Math.max(0, height - border.length * 2 - 4);
    let rows: string[];
    if (this.help) rows = this.helpRows();
    else {
      rows = allowanceRows(
        scopedSnapshots(this.accounts, { ...this.options, provider: this.provider }),
        inner,
        t,
        this.options.providerNames,
      );
      if (!rows.length)
        rows = [
          t.fg(
            "muted",
            this.options.liveError ?? "No signed-in subscriptions or Firecrawl key. Use /login.",
          ),
        ];
    }
    const body = this.scrollRows(rows, bodyRoom);
    const lines = [
      ...border,
      `  ${truncateToWidth(heading, inner)}`,
      "",
      ...body.slice(0, bodyRoom).map((s) => `  ${s}`),
      "",
      `  ${t.fg("dim", navigation)}`,
      ...border,
    ];
    const fitted = lines.length > height ? [...lines.slice(0, height - 1), ...border] : lines;
    return fitted.map((line) => truncateToWidth(line, width));
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
  accounts: AccountInfo[],
  options: DashboardOptions = {},
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      [
        "Remaining allowances",
        ...allowanceLines(scopedSnapshots(accounts, options)),
        ...(options.liveError ? [options.liveError] : []),
      ].join("\n"),
      "info",
    );
    return;
  }
  const providerNames = new Map(options.providerNames);
  for (const id of new Set([
    ...accounts.map((a) => a.provider),
    ...(options.snapshots ?? []).map((s) => s.account.provider),
  ])) {
    const name = ctx.modelRegistry.getProvider(id)?.name;
    if (name) providerNames.set(id, name);
  }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const dashboard = new UsageDashboard(
      accounts,
      theme,
      keys,
      () => done(),
      () => tui.terminal.rows,
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
