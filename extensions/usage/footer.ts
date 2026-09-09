import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFooterStatus } from "../../src/footer-status.ts";
import type { AllowanceSnapshot } from "./allowances.ts";
import { safeLabel } from "./ledger.ts";
import { allowanceLabel } from "./presentation.ts";

export function formatUsageFooter(snapshot: AllowanceSnapshot, now = Date.now()): string {
  if (snapshot.unsupported) return "usage unsupported";
  if (snapshot.unavailable || !snapshot.allowances.length) return "usage unavailable";
  const allowances = snapshot.allowances.filter(
    (a) => !/\bspark\b/i.test(`${a.label} ${a.shortLabel ?? ""}`),
  );
  if (!allowances.length) return "usage unavailable";
  const values = allowances.map((allowance) => {
    const label =
      allowances.length > 1
        ? safeLabel(allowance.shortLabel ?? allowance.label)
            .toLowerCase()
            .replaceAll("5-hour", "5h")
        : "";
    const value =
      allowance.resetsAt !== undefined && allowance.resetsAt <= now
        ? "?"
        : allowanceLabel(allowance)
            .replace(/ remaining$/, "")
            .replace("Remaining unavailable", "?");
    return `remaining ${label ? label + " " : ""}${safeLabel(value)}`;
  });
  return values.join(" · ");
}

/** One active-account read at a time; switching/shutdown invalidates late completions. */
export class UsageFooter {
  private ctx?: ExtensionContext;
  private accountId?: string;
  private snapshot?: AllowanceSnapshot;
  private pending?: AbortController;
  private checkedAt = 0;
  private closed = false;
  private load: (
    ctx: ExtensionContext,
    accountId: string,
    signal: AbortSignal,
  ) => Promise<AllowanceSnapshot | undefined>;
  private enabled: () => boolean;
  private now: () => number;
  constructor(load: UsageFooter["load"], enabled: () => boolean, now: () => number = Date.now) {
    this.load = load;
    this.enabled = enabled;
    this.now = now;
  }

  update(ctx: ExtensionContext, accountId?: string, force = false): void {
    if (this.closed) return;
    this.ctx = ctx;
    const next = ctx.hasUI && this.enabled() ? accountId : undefined;
    if (next !== this.accountId) {
      this.pending?.abort();
      this.pending = undefined;
      this.snapshot = undefined;
      this.checkedAt = 0;
      this.accountId = next;
    }
    if (!next) {
      setFooterStatus(ctx, "usage", undefined);
      return;
    }
    if (this.pending) {
      if (!force) return;
      this.pending.abort();
    }
    if (!force && this.checkedAt && this.now() - this.checkedAt < 60_000) {
      this.render();
      return;
    }
    const request = new AbortController();
    this.pending = request;
    setFooterStatus(ctx, "usage", "usage …");
    void this.load(ctx, next, AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]))
      .then(
        (snapshot) => {
          if (this.pending !== request || this.closed) return;
          this.snapshot = snapshot;
        },
        () => {
          if (this.pending !== request || this.closed) return;
          this.snapshot = undefined;
        },
      )
      .finally(() => {
        if (this.pending !== request || this.closed) return;
        this.pending = undefined;
        this.checkedAt = this.now();
        this.render();
      });
  }

  accept(snapshots: AllowanceSnapshot[]): void {
    if (this.closed || !this.accountId) return;
    const snapshot = snapshots.find((s) => s.account.id === this.accountId);
    if (!snapshot) return;
    this.pending?.abort();
    this.pending = undefined;
    this.snapshot = snapshot;
    this.checkedAt = this.now();
    this.render();
  }

  private render(): void {
    if (this.ctx)
      setFooterStatus(
        this.ctx,
        "usage",
        this.snapshot ? formatUsageFooter(this.snapshot, this.now()) : "usage unavailable",
      );
  }

  close(): void {
    this.closed = true;
    this.pending?.abort();
    this.pending = undefined;
    if (this.ctx) setFooterStatus(this.ctx, "usage", undefined);
    this.ctx = undefined;
  }
}
