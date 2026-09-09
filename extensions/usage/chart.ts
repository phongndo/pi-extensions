import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { UsageRecord } from "./ledger.ts";
import { count, money, type Period } from "./model.ts";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export type ChartMetric = "tokens" | "cost";
export interface Timeline {
  from: number;
  to: number;
  step: number;
  values: number[];
}
/** Caller supplies the scoped records. Bin count is width-bounded, not proportional to history length. */
export function buildTimeline(
  records: UsageRecord[],
  period: Period,
  metric: ChartMetric,
  columns: number,
  now = Date.now(),
): Timeline | undefined {
  const today = Math.floor(now / DAY) * DAY;
  const since = period === "7d" ? today - 6 * DAY : period === "30d" ? today - 29 * DAY : 0;
  const rows = records.filter((r) => r.timestamp >= since && r.timestamp <= now);
  if (!rows.length) return;
  const earliest = rows.reduce((first, row) => Math.min(first, row.timestamp), now);
  let unit = DAY;
  if (period === "session")
    unit = now - earliest <= 6 * HOUR ? MINUTE : now - earliest <= 7 * DAY ? HOUR : DAY;
  const from = period === "7d" || period === "30d" ? since : Math.floor(earliest / unit) * unit;
  const to = (Math.floor(now / unit) + 1) * unit;
  const capacity = Math.max(1, Math.min(200, Math.floor(columns)));
  const step = Math.max(1, Math.ceil((to - from) / unit / capacity)) * unit;
  const values = Array.from({ length: Math.ceil((to - from) / step) }, () => 0);
  for (const row of rows) {
    const index = Math.floor((row.timestamp - from) / step);
    values[index]! += metric === "tokens" ? row.usage.totalTokens : row.usage.cost.total;
  }
  return { from, to, step, values };
}
function valueLabel(value: number, metric: ChartMetric): string {
  const label =
    metric === "tokens"
      ? count(value)
      : value > 0 && value < 0.0001
        ? `$${value.toExponential(1)}`
        : value >= 10000
          ? `$${count(value)}`
          : money(value);
  return label.length <= 10 ? label : `${metric === "cost" ? "$" : ""}${value.toExponential(1)}`;
}
function stepLabel(step: number): string {
  return step >= DAY ? `${step / DAY}d` : step >= HOUR ? `${step / HOUR}h` : `${step / MINUTE}m`;
}
function timeLabel(value: number, session: boolean): string {
  const iso = new Date(value).toISOString();
  return session ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** A responsive native terminal histogram with value scale, UTC range, and honest empty/zero states. */
export function renderTimeline(
  records: UsageRecord[],
  period: Period,
  metric: ChartMetric,
  width: number,
  height: number,
  theme: Theme,
  now = Date.now(),
): string[] {
  if (height <= 0 || width <= 0) return [];
  const fit = (lines: string[]) =>
    lines.slice(0, height).map((line) => truncateToWidth(line, width));
  const timeline = buildTimeline(records, period, metric, Math.max(1, width - 14), now);
  if (!timeline)
    return fit([
      theme.fg("muted", " No usage recorded yet."),
      theme.fg("dim", " History starts with requests made while Usage is loaded."),
    ]);
  const max = Math.max(...timeline.values);
  const metricLabel = metric === "tokens" ? "Tokens" : "Price equivalent";
  const first = timeLabel(timeline.from, period === "session");
  const last = timeLabel(Math.min(now, timeline.to - 1), period === "session");
  const title = ` ${metricLabel} over time · ${stepLabel(timeline.step)}/bar · UTC`;
  if (width < 30 || height < 4)
    return fit([
      theme.fg(
        "muted",
        `${metricLabel}: ${valueLabel(
          timeline.values.reduce((a, b) => a + b, 0),
          metric,
        )}`,
      ),
      theme.fg("dim", `${first} → ${last} UTC`),
    ]);
  const peak = valueLabel(max, metric);
  const axisWidth = Math.max(peak.length, valueLabel(0, metric).length);
  const room = Math.max(1, width - axisWidth - 4);
  const slot = Math.max(1, Math.floor(room / timeline.values.length));
  const barWidth = Math.max(1, Math.min(8, slot - 1));
  const plotWidth = slot * timeline.values.length;
  const plotHeight = Math.max(1, Math.min(6, height - 3));
  const lines = [theme.fg("muted", title)];
  for (let row = plotHeight - 1; row >= 0; row--) {
    const label = row === plotHeight - 1 ? peak : "";
    let bars = "";
    for (const value of timeline.values) {
      const fraction = max ? Math.min(1, Math.max(0, (value / max) * plotHeight - row)) : 0;
      const glyph = fraction ? "▁▂▃▄▅▆▇█"[Math.ceil(fraction * 8) - 1]! : " ";
      bars += glyph.repeat(barWidth) + " ".repeat(slot - barWidth);
    }
    lines.push(theme.fg("dim", ` ${label.padStart(axisWidth)} │`) + theme.fg("accent", bars));
  }
  lines.push(
    theme.fg("dim", ` ${valueLabel(0, metric).padStart(axisWidth)} └${"─".repeat(plotWidth)}`),
  );
  const gap = Math.max(1, plotWidth - first.length - last.length);
  const range =
    plotWidth >= first.length + last.length + 1
      ? first + " ".repeat(gap) + last
      : `${first} → ${last}`;
  lines.push(theme.fg("dim", `${" ".repeat(axisWidth + 3)}${range}`));
  if (!max)
    lines[0] = theme.fg(
      "muted",
      ` ${metricLabel}: zero reported · ${stepLabel(timeline.step)}/bar · UTC`,
    );
  return fit(lines);
}
