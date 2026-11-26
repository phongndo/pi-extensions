import { stripVTControlCharacters } from "node:util";
import {
  getLanguageFromPath,
  highlightCode,
  renderDiff,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { builtinRenderers, customResult, sameRenderer } from "./builtins.ts";
import { clip, Fit, Lines } from "./frame.ts";
import {
  contentLines,
  countMatches,
  displayName,
  displayPath,
  formatDuration,
  lineRange,
  NOTICE,
  num,
  oneLine,
  parseShellOutput,
  plural,
  resultText,
  str,
  summarizeArgs,
  type Args,
  type RenderContext,
  type ToolResult,
} from "./text.ts";
import type { Timeline } from "./timeline.ts";

export type { RenderContext, ToolResult } from "./text.ts";
export type Status = "pending" | "ok" | "error";

const SHELLS = new Set(["bash", "powershell"]);
/** Reads and searches: consecutive ones share one `Explored` block, as in Codex. */
export const EXPLORE = new Set(["read", "grep", "find", "ls"]);

/** Collapsed output keeps this many lines: the first and last two around a `… +N lines` count. */
export const PREVIEW_LINES = 5;
/** Collapsed diffs keep this many lines. */
export const DIFF_PREVIEW_LINES = 8;

const BULLET = "•";
const GUTTER = "└ ";

/** What the transcript knows about one tool call, collected from its row's renderers. */
export interface CallRecord {
  id: string;
  tool: string;
  args: Args;
  cwd: string;
  status: Status;
  durationMs: number | undefined;
  result: ToolResult | undefined;
  /** The renderers the tool had before this extension, for tools it does not know. */
  inner: ToolRenderers | undefined;
  innerCall: Component | undefined;
  innerResult: Component | undefined;
  innerState: Record<string, unknown>;
  /** Drawn in the live transcript, as opposed to an HTML export of it. */
  live: boolean;
  /** Expanded as drawn: Pi's state, or a click Pi could not take (see `CallView.handleMouse`). */
  expanded: boolean;
  /** Pi's expanded state for the row. */
  piExpanded: boolean;
  /** A click's expanded state, until Pi's state changes. */
  override: boolean | undefined;
  outputPad: number;
  /** The configured expand key, for the `… +N lines` hint. */
  expandKey: string;
  /** Another extension renders this built-in tool's result: show `innerResult` as the body. */
  customResult?: boolean;
  /** Listed in the row index (live rows, once). */
  registered?: boolean;
  memo?: Map<string, { key: unknown[]; value: unknown }>;
}

export function statusOf(context: Pick<RenderContext, "isPartial" | "isError">): Status {
  if (context.isPartial) return "pending";
  return context.isError ? "error" : "ok";
}

/** Rows redraw on every frame: keep derived text while a call's inputs stay the same. */
function memo<T>(record: CallRecord, name: string, key: unknown[], compute: () => T): T {
  record.memo ??= new Map();
  const cached = record.memo.get(name);
  if (cached && cached.key.length === key.length && cached.key.every((v, i) => v === key[i]))
    return cached.value as T;
  const value = compute();
  record.memo.set(name, { key, value });
  return value;
}

const inputs = (record: CallRecord, theme: Theme) => [
  record.result,
  record.args,
  record.status,
  record.cwd,
  record.expanded,
  record.durationMs,
  record.innerResult,
  theme,
];

function moreLines(hidden: number, record: CallRecord, theme: Theme): string {
  const hint = record.expandKey ? `click or ${record.expandKey}` : "click";
  return theme.fg("dim", `… +${plural(hidden, "line")} (${hint})`);
}

/** Head and tail of `lines` around a `… +N lines` count. */
export function preview(
  lines: string[],
  more: (hidden: number) => string,
  max = PREVIEW_LINES,
): string[] {
  if (lines.length <= max) return lines;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return [
    ...lines.slice(0, head),
    more(lines.length - head - tail),
    ...lines.slice(lines.length - tail),
  ];
}

/** The first lines of `lines`, then a `… +N lines` count; `max` lines in all. */
function headOf(lines: string[], more: (hidden: number) => string, max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max - 1), more(lines.length - max + 1)];
}

/** One block: a bullet and header, then a body under `└`. */
export interface Cell {
  status: Status;
  verb: string;
  /** Styled target lines; collapsed headers show the first. */
  target: string[];
  /** Styled text right after the target, such as `(+1 -1)`. */
  suffix?: string;
  /** Styled notes after the target: counts, durations, exit codes. */
  meta: string[];
  body: Component[];
}

const EMPTY_RESULT = /^(No matches found|No files found|\(empty directory\))/;

const firstLine = (text: string) => text.trim().split("\n")[0]?.trim() ?? "";

/** An exploration call as one line: `Read a.ts`, `Search "x" in src · 4 matches`. */
export function exploreLine(
  record: CallRecord,
  theme: Theme,
): { verb: string; target: string; meta: string[] } {
  return memo(record, "explore", inputs(record, theme), () => {
    const { tool, args, status, result } = record;
    const text = status === "pending" ? "" : resultText(result);
    const failed = status === "error" ? [theme.fg("error", firstLine(text) || "failed")] : [];
    const where = str(args.path);
    const inPath = where && where !== "." ? ` in ${displayPath(where, record.cwd)}` : "";
    const empty = EMPTY_RESULT.test(text.trim());
    switch (tool) {
      case "read":
        return {
          verb: "Read",
          target: displayPath(str(args.path ?? args.file_path), record.cwd) + lineRange(args),
          meta: failed,
        };
      case "grep": {
        const glob = oneLine(str(args.glob));
        const total = num(
          (result?.details as { totalMatched?: unknown } | undefined)?.totalMatched,
        );
        const withContext = (num(args.context) ?? 0) > 0;
        const matches = empty ? 0 : (total ?? countMatches(text, withContext));
        return {
          verb: "Search",
          target: `${JSON.stringify(str(args.pattern))}${inPath}${glob ? ` (${glob})` : ""}`,
          meta:
            status === "ok"
              ? [theme.fg("dim", matches ? plural(matches, "match", "matches") : "no matches")]
              : failed,
        };
      }
      case "find": {
        const n = empty ? 0 : contentLines(text).length;
        return {
          verb: "Find",
          target: `${oneLine(str(args.pattern))}${inPath}`,
          meta: status === "ok" ? [theme.fg("dim", plural(n, "file"))] : failed,
        };
      }
      default:
        return { verb: "List", target: displayPath(where || ".", record.cwd), meta: failed };
    }
  });
}

/** Everything a call produced, for the expanded view. */
function details(record: CallRecord, theme: Theme): string[] {
  const { tool, args, result } = record;
  if (!result) return [];
  const text = resultText(result);
  const out = (lines: string[]) => lines.map((line) => theme.fg("toolOutput", line));
  if (record.status === "error")
    return text
      .trim()
      .split("\n")
      .map((line) => theme.fg("error", line));
  switch (tool) {
    case "read": {
      const note = NOTICE.exec(text);
      const body = (note ? text.slice(0, note.index) : text).replace(/\n$/, "");
      const lang = getLanguageFromPath(str(args.path));
      return [
        ...(lang ? highlightCode(body, lang) : out(body.split("\n"))),
        ...(note ? [theme.fg("dim", note[0].trim())] : []),
      ];
    }
    case "write": {
      const content = str(args.content).replace(/\n$/, "");
      const lang = getLanguageFromPath(str(args.path));
      return lang ? highlightCode(content, lang) : out(content.split("\n"));
    }
    default:
      return out(text.replace(/\n+$/, "").split("\n"));
  }
}

/** Consecutive reads and searches as one `Explored` block. */
export function exploredCell(
  records: readonly CallRecord[],
  expanded: boolean,
  theme: Theme,
): Cell {
  const status: Status = records.some((r) => r.status === "error")
    ? "error"
    : records.some((r) => r.status === "pending")
      ? "pending"
      : "ok";
  const rows: Component[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    let line = exploreLine(record, theme);
    // Reads in a row read as one line, unless expanded to show each file.
    if (!expanded && record.tool === "read" && record.status === "ok") {
      const paths = [line.target];
      while (
        i + 1 < records.length &&
        records[i + 1]!.tool === "read" &&
        records[i + 1]!.status === "ok"
      )
        paths.push(exploreLine(records[++i]!, theme).target);
      line = { ...line, target: paths.join(", ") };
    }
    const tail =
      line.meta.length > 0
        ? ` ${theme.fg("dim", "·")} ${line.meta.join(theme.fg("dim", " · "))}`
        : "";
    const head = `${theme.fg("toolTitle", line.verb)} `;
    rows.push(new Fit(head, theme.fg("muted", line.target), tail));
    if (expanded && record.customResult && record.innerResult)
      rows.push(new Indent(record.innerResult));
    else if (expanded) {
      const lines = memo(record, "details", inputs(record, theme), () => details(record, theme));
      if (lines.length > 0)
        rows.push(
          new Lines(
            lines.map((l) => `  ${l}`),
            true,
          ),
        );
    }
  }
  return {
    status,
    verb: status === "pending" ? "Exploring" : "Explored",
    target: [],
    meta: [],
    body: rows,
  };
}

const NESTED_VERBS: Record<string, string> = {
  read: "Read",
  bash: "Ran",
  powershell: "Ran",
  edit: "Edited",
  write: "Wrote",
  grep: "Searched",
  find: "Found",
  ls: "Listed",
};

/** A call a script made, as one line: `Read a.ts`, `Ran git status`. */
export function nestedCallLine(
  call: { name?: unknown; args?: unknown; status?: unknown },
  cwd: string,
): string {
  const name = typeof call.name === "string" ? call.name : "tool";
  const args = parseNestedArgs(call.args);
  const pattern = str(args.pattern);
  const path = str(args.path) && displayPath(str(args.path), cwd);
  let target: string;
  if (str(args.command)) target = str(args.command).trim().split("\n")[0] ?? "";
  else if (pattern)
    target = `${name === "grep" ? JSON.stringify(pattern) : oneLine(pattern)}${path && path !== "." ? ` in ${path}` : ""}`;
  else if (path) target = path;
  else target = NESTED_VERBS[name] ? "" : summarizeArgs(args);
  return `${NESTED_VERBS[name] ?? displayName(name)} ${target}`.trim();
}

const NESTED_FIELDS = ["command", "path", "pattern", "query"] as const;

/**
 * A nested call's arguments. Pi records them as JSON and cuts long ones short, so a cut record
 * still yields the fields that start before the cut.
 */
export function parseNestedArgs(raw: unknown): Args {
  if (raw && typeof raw === "object") return raw as Args;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Args;
  } catch {
    // Cut short: recover the leading string fields below.
  }
  const args: Args = {};
  for (const field of NESTED_FIELDS) {
    const match = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw);
    if (!match) continue;
    let value = match[1]!.replace(/\\+$/, (tail) => (tail.length % 2 ? tail.slice(1) : tail));
    try {
      value = JSON.parse(`"${value}"`) as string;
    } catch {
      // Keep the escaped text.
    }
    args[field] = value;
  }
  return Object.keys(args).length > 0 ? args : { args: raw };
}

/** The block for one call that is not a read or search. */
export function cellOf(record: CallRecord, theme: Theme): Cell {
  return memo(record, "cell", inputs(record, theme), () => {
    const cell = buildCell(record, theme);
    if (!record.customResult || !record.innerResult) return cell;
    const more = (hidden: number) => moreLines(hidden, record, theme);
    const body = record.expanded
      ? record.innerResult
      : new Capped(record.innerResult, PREVIEW_LINES, more);
    return { ...cell, body: [body] };
  });
}

function buildCell(record: CallRecord, theme: Theme): Cell {
  const { tool, args, status, result, expanded } = record;
  const running = status === "pending";
  const more = (hidden: number) => moreLines(hidden, record, theme);
  const dim = (value: string) => theme.fg("dim", value);
  const out = (lines: string[]) => lines.map((line) => theme.fg("toolOutput", line));
  const meta: string[] = [];
  if (record.durationMs !== undefined && record.durationMs >= 1000)
    meta.push(dim(formatDuration(record.durationMs)));
  const errorBody = (): Component[] => {
    const lines = resultText(result)
      .trim()
      .split("\n")
      .map((line) => theme.fg("error", line));
    return [new Lines(expanded ? lines : headOf(lines, more, 3), expanded)];
  };

  if (SHELLS.has(tool)) {
    const command = str(args.command).trim().split("\n");
    const target = highlightCode(
      expanded ? command.join("\n") : (command[0] ?? ""),
      tool === "bash" ? "bash" : "powershell",
    );
    if (!expanded && command.length > 1)
      meta.unshift(dim(`+${plural(command.length - 1, "line")}`));
    const output = parseShellOutput(resultText(result), status === "error");
    if (output.failure) meta.push(theme.fg("error", output.failure));
    let body: string[];
    if (running) body = output.lines.slice(-3).map((line) => dim(line));
    else if (expanded)
      body = [
        ...out(output.lines),
        ...(output.lines.length === 0 ? [dim("(no output)")] : []),
        ...(output.notice ? [dim(output.notice)] : []),
        ...(output.status ? [theme.fg("error", output.status)] : []),
      ];
    else body = output.lines.length > 0 ? out(preview(output.lines, more)) : [dim("(no output)")];
    return {
      status,
      verb: running ? "Running" : "Ran",
      target,
      meta,
      body: body.length > 0 ? [new Lines(body, expanded)] : [],
    };
  }

  const path = displayPath(str(args.path ?? args.file_path), record.cwd);
  switch (tool) {
    case "edit": {
      const diff = str((result?.details as { diff?: unknown } | undefined)?.diff);
      const lines = diff ? renderDiff(diff).split("\n") : [];
      const added = diff.split("\n").filter((line) => line.startsWith("+")).length;
      const removed = diff.split("\n").filter((line) => line.startsWith("-")).length;
      const suffix =
        status === "ok" && diff
          ? `${dim("(")}${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}${dim(")")}`
          : undefined;
      const body =
        status === "error"
          ? errorBody()
          : lines.length > 0
            ? [new Lines(expanded ? lines : headOf(lines, more, DIFF_PREVIEW_LINES), expanded)]
            : [];
      return {
        status,
        verb: running ? "Editing" : "Edited",
        target: [theme.fg("muted", path)],
        ...(suffix ? { suffix } : {}),
        meta,
        body,
      };
    }
    case "write": {
      const content = str(args.content);
      const n = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
      const body =
        status === "error"
          ? errorBody()
          : expanded
            ? [new Lines(details(record, theme), true)]
            : [];
      return {
        status,
        verb: running ? "Writing" : "Wrote",
        target: [theme.fg("muted", path)],
        ...(status === "ok" ? { suffix: dim(`(${plural(n, "line")})`) } : {}),
        meta,
        body,
      };
    }
    case "codemode": {
      const calls = ((result?.details as { calls?: unknown } | undefined)?.calls ?? []) as Array<{
        name?: unknown;
        args?: unknown;
        status?: unknown;
      }>;
      const failed = calls.filter((call) => call.status === "error").length;
      if (calls.length > 0) meta.unshift(dim(plural(calls.length, "call")));
      if (failed > 0) meta.push(theme.fg("error", `${failed} failed`));
      const script = str(args.code).trim();
      let body: Component[];
      if (expanded) {
        body = [new Lines(highlightCode(script, "javascript"), true)];
        if (record.innerResult) body.push(record.innerResult);
      } else if (status === "error" && calls.length === 0) body = errorBody();
      else {
        const lines = calls.map((call) => {
          const line = nestedCallLine(call, record.cwd);
          return call.status === "error" ? theme.fg("error", line) : theme.fg("toolOutput", line);
        });
        body = lines.length > 0 ? [new Lines(preview(lines, more))] : [];
      }
      return {
        status,
        verb: running ? "Running script" : "Ran script",
        target: [],
        meta,
        body,
      };
    }
    default: {
      let verb: string;
      let target = "";
      if (tool === "advisor") verb = running ? "Asking advisor" : "Asked advisor";
      else if (tool === "question") {
        const questions = Array.isArray(args.questions)
          ? (args.questions as Array<{ question?: unknown }>)
          : [];
        verb = running ? "Asking" : "Asked";
        target =
          questions.length === 1
            ? oneLine(str(questions[0]?.question))
            : plural(questions.length, "question");
      } else {
        verb = running ? "Calling" : "Called";
        // A tool with its own call renderer chose what to show of its arguments: show only its name.
        target = record.inner?.renderCall
          ? displayName(tool)
          : `${displayName(tool)}(${summarizeArgs(args)})`;
      }
      let body: Component[] = [];
      if (status === "error") body = errorBody();
      else if (record.innerResult)
        body = [
          expanded ? record.innerResult : new Capped(record.innerResult, PREVIEW_LINES, more),
        ];
      else if (result) {
        const lines = out(resultText(result).replace(/\n+$/, "").split("\n"));
        if (lines.some((line) => line.trim()))
          body = [new Lines(expanded ? lines : preview(lines, more), expanded)];
      }
      return { status, verb, target: target ? [theme.fg("muted", target)] : [], meta, body };
    }
  }
}

const blank = (line: string) => stripVTControlCharacters(line).trim() === "";

/** Without blank lines at either end: tools' own renderers often pad themselves with spacers. */
function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && blank(lines[start]!)) start++;
  while (end > start && blank(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}

/** At most `max` lines of another tool's own component, then a `… +N lines` count. */
class Capped implements Component {
  inner: Component;
  max: number;
  more: (hidden: number) => string;

  constructor(inner: Component, max: number, more: (hidden: number) => string) {
    this.inner = inner;
    this.max = max;
    this.more = more;
  }

  private last: { drawn: string[]; lines: string[] } | undefined;

  render(width: number): string[] {
    const drawn = this.inner.render(width);
    // The same lines from `inner` give the same lines here, so a row can tell nothing changed.
    if (this.last?.drawn === drawn) return this.last.lines;
    const lines = trimBlank(drawn);
    this.last = {
      drawn,
      lines:
        lines.length <= this.max
          ? lines
          : [...lines.slice(0, this.max - 1), this.more(lines.length - this.max + 1)],
    };
    return this.last.lines;
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

const BULLET_COLOR = { pending: "dim", ok: "success", error: "error" } as const;

/** Lines another renderer's component drew, to tell on the next frame whether it changed. */
interface Drawn {
  part: Component;
  width: number;
  lines: string[];
}

interface Region {
  component: Component;
  top: number;
  left: number;
  height: number;
}

/** The header lines of a block: `• Verb target · notes`. */
export function drawHeader(
  cell: Cell,
  pad: number,
  expanded: boolean,
  width: number,
  theme: Theme,
): string[] {
  const headerWidth = width - pad - 2;
  if (headerWidth < 1) return [];
  const left = " ".repeat(pad);
  const verb = theme.fg("toolTitle", theme.bold(cell.verb));
  const tail =
    (cell.suffix ? ` ${cell.suffix}` : "") +
    (cell.meta.length > 0
      ? ` ${theme.fg("dim", "·")} ${cell.meta.join(theme.fg("dim", " · "))}`
      : "");
  const header: Component = expanded
    ? new Lines(
        cell.target.length > 0
          ? cell.target.map(
              (line, i) =>
                (i === 0 ? `${verb} ` : "") + line + (i === cell.target.length - 1 ? tail : ""),
            )
          : [verb + tail],
        true,
      )
    : new Fit(cell.target.length > 0 ? `${verb} ` : verb, cell.target[0] ?? "", tail);
  const bullet = theme.fg(BULLET_COLOR[cell.status], BULLET);
  return header
    .render(headerWidth)
    .map((line, i) => `${left}${i === 0 ? bullet : " "} ${clip(line, headerWidth)}`);
}

/**
 * The body lines of a block, under `└`. Other tools' own components are clipped to the width and
 * recorded in `regions`, offset by `top`, so clicks can reach them.
 */
export function drawBody(
  cell: Cell,
  pad: number,
  width: number,
  theme: Theme,
  regions: Region[] = [],
  top = 0,
  foreign: Drawn[] = [],
): string[] {
  const bodyWidth = width - pad - 4;
  if (bodyWidth < 1) return [];
  const left = " ".repeat(pad);
  const lines: string[] = [];
  for (const part of cell.body) {
    const drawn = part.render(bodyWidth);
    if (!(part instanceof Lines || part instanceof Fit))
      foreign.push({ part, width: bodyWidth, lines: drawn });
    const start = lines.length;
    for (const line of drawn)
      lines.push(
        `${left}  ${lines.length === 0 ? theme.fg("dim", GUTTER) : "  "}${clip(line, bodyWidth)}`,
      );
    if (!(part instanceof Lines || part instanceof Fit || part instanceof Capped))
      regions.push({ component: part, top: top + start, left: pad + 4, height: drawn.length });
  }
  return lines;
}

/** A whole block: its header, then its body. */
export function drawCell(
  cell: Cell,
  pad: number,
  expanded: boolean,
  width: number,
  theme: Theme,
  regions: Region[] = [],
  foreign: Drawn[] = [],
): string[] {
  const header = drawHeader(cell, pad, expanded, width, theme);
  if (header.length === 0) return [];
  return [...header, ...drawBody(cell, pad, width, theme, regions, header.length, foreign)];
}

/**
 * Live rows by call id: a run of reads finds its members here. It also knows which calls stand
 * apart from runs (rows another renderer draws, reads that show an image), and forgets rows Pi
 * dropped when it draws the transcript again.
 */
export class RowIndex {
  private rows = new Map<string, CallRecord>();
  private apart = new Set<string>();
  private seenIn = new Map<string, number>();
  private batch = 0;
  private batchOpen = false;
  private redrawn = false;
  /** Called when a call starts or stops standing apart, which changes runs. */
  onApartChange: () => void = () => {};

  get size(): number {
    return this.rows.size;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  get(id: string): CallRecord | undefined {
    return this.rows.get(id);
  }

  /** A live row drew. True when it replaced another row for the call: Pi drew everything again. */
  register(record: CallRecord): boolean {
    this.openBatch();
    const previous = this.rows.get(record.id);
    const replaced = previous !== undefined && previous !== record;
    if (replaced) this.redrawn = true;
    this.rows.set(record.id, record);
    this.seenIn.set(record.id, this.batch);
    return replaced;
  }

  /** Forget rows for calls Pi no longer draws, as after a compaction. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.rows.keys())
      if (!ids.has(id)) {
        this.rows.delete(id);
        this.seenIn.delete(id);
      }
  }

  /** Keep a call out of runs, or let it back in. */
  setApart(id: string, apart: boolean): void {
    if (apart === this.apart.has(id)) return;
    if (apart) this.apart.add(id);
    else this.apart.delete(id);
    this.onApartChange();
  }

  isApart(id: string): boolean {
    return this.apart.has(id);
  }

  /** Rows drawn in one synchronous pass form a batch; a redraw batch replaces every row. */
  private openBatch(): void {
    if (this.batchOpen) return;
    this.batchOpen = true;
    const batch = ++this.batch;
    queueMicrotask(() => {
      this.batchOpen = false;
      if (this.redrawn)
        for (const [id, seen] of this.seenIn)
          if (seen !== batch) {
            this.rows.delete(id);
            this.seenIn.delete(id);
          }
      this.redrawn = false;
    });
  }
}

/**
 * Forward a mouse event to `component` at `left`/`top` within this view, the way Pi's containers
 * do (`dispatchMouseEvent`), so drags and focus go to the component itself.
 */
function forwardMouse(
  component: Component,
  event: TuiMouseEvent,
  region: Region,
): TuiMouseEventResult | undefined {
  const local: TuiMouseEvent = {
    ...event,
    x: event.x - region.left,
    y: event.y - region.top,
    width: Math.max(1, event.width - region.left),
    height: region.height,
  };
  const result = component.handleMouse?.(local);
  if (!result) return undefined;
  // Forwarded by the component to a child it hosts: like Pi's containers, keep focus on the host.
  if ("target" in result)
    return (
      result.focus && component.handleInput ? { ...result, focusTarget: component } : result
    ) as TuiMouseEventResult;
  if (!result.handled && !result.capture && !result.focus) return undefined;
  return {
    ...result,
    handled: true,
    ...(result.focus ? { focusTarget: component } : {}),
    target: {
      component,
      originX: local.screenX - local.x,
      originY: local.screenY - local.y,
      width: local.width,
      height: local.height,
    },
  } as TuiMouseEventResult;
}

/**
 * The view a row's call slot returns. In the live transcript most rows draw their own block, and a
 * run of reads and searches shares an `Explored` block drawn by its first row while the others draw
 * nothing. In an HTML export each row stands alone: this draws its header and `BodyView` its body.
 */
export class CallView implements Component {
  record: CallRecord;
  index: RowIndex;
  timeline: Timeline;
  theme: Theme;
  private regions: Region[] = [];
  /** A run whose first call is still running, though others have results. */
  private waitingRun = false;
  /**
   * Pi repaints every row each frame. A block drawn only from Tidy's own text is a function of
   * the width and its calls' inputs, so it is kept until one of them changes.
   */
  private drawn:
    | {
        key: unknown[];
        lines: string[];
        waitingRun: boolean;
        regions: Region[];
        foreign: Drawn[];
      }
    | undefined;

  constructor(record: CallRecord, index: RowIndex, timeline: Timeline, theme: Theme) {
    this.record = record;
    this.index = index;
    this.timeline = timeline;
    this.theme = theme;
  }

  render(width: number): string[] {
    this.regions = [];
    this.waitingRun = false;
    const own = this.record;
    // An export draws the call before its result, so its header cannot know the outcome yet.
    if (!own.live)
      return drawHeader(
        { ...standaloneCell(own, this.theme), status: "pending" },
        own.outputPad,
        own.expanded,
        width,
        this.theme,
      );
    let run: CallRecord[] | undefined;
    if (EXPLORE.has(own.tool)) {
      const ids = this.timeline.segment(own.id) ?? [own.id];
      // The first call with a live row draws the run.
      const leader = leaderOf(ids, this.index);
      if (leader !== undefined && leader !== own.id) return [];
      run = ids.flatMap((id) => {
        const record = id === own.id ? own : this.index.get(id);
        return record ? [record] : [];
      });
    }
    const key = drawKey(width, run ?? [own], this.theme);
    const drawn = this.drawn;
    // Another renderer's component can change while every input stays the same: such a row
    // keeps its lines only while each of those components draws the very same lines again.
    if (
      drawn &&
      sameKey(drawn.key, key) &&
      drawn.foreign.every(({ part, width, lines }) => part.render(width) === lines)
    ) {
      this.waitingRun = drawn.waitingRun;
      this.regions = drawn.regions;
      return drawn.lines;
    }
    let cell: Cell;
    if (run) {
      this.waitingRun = !own.result && run.some((record) => record.result);
      cell = exploredCell(run, own.expanded, this.theme);
    } else cell = cellOf(own, this.theme);
    const foreign: Drawn[] = [];
    const lines = drawCell(
      cell,
      own.outputPad,
      own.expanded,
      width,
      this.theme,
      this.regions,
      foreign,
    );
    this.drawn = { key, lines, waitingRun: this.waitingRun, regions: this.regions, foreign };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const region = this.regions.find(
      ({ top, height, left }) => event.y >= top && event.y < top + height && event.x >= left,
    );
    if (region) {
      const forwarded = forwardMouse(region.component, event, region);
      if (forwarded) return forwarded;
    }
    // Pi toggles only rows with a result: a run whose first read is still running toggles here,
    // and keeps toggling here while its state differs from Pi's.
    const own = this.record;
    const click = event.type === "click" && event.button === "left";
    if (click && (this.waitingRun || own.override !== undefined)) {
      const next = !own.expanded;
      own.override = next === own.piExpanded ? undefined : next;
      own.expanded = next;
      return { handled: true };
    }
    return undefined;
  }

  invalidate(): void {
    this.drawn = undefined;
    this.record.memo?.clear();
    this.record.innerCall?.invalidate();
    this.record.innerResult?.invalidate();
  }
}

/** What a block's lines depend on: the width and, for each call drawn, its inputs. */
function drawKey(width: number, run: readonly CallRecord[], theme: Theme): unknown[] {
  const key: unknown[] = [width, run.length];
  for (const record of run)
    key.push(record, ...inputs(record, theme), record.outputPad, record.expandKey);
  return key;
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A row's result slot. Live rows draw everything from the call slot; an export draws the body here. */
export class BodyView implements Component {
  record: CallRecord;
  theme: Theme;

  constructor(record: CallRecord, theme: Theme) {
    this.record = record;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (this.record.live) return [];
    const cell = standaloneCell(this.record, this.theme);
    // The export's header was drawn before the result: say how a failed call ended here.
    if (this.record.status === "error") {
      const notes = cell.meta.filter((note) => stripVTControlCharacters(note).trim() !== "");
      const failure = notes.length > 0 ? notes.join(" · ") : this.theme.fg("error", "failed");
      cell.body = [...cell.body, new Lines([failure])];
    }
    return drawBody(cell, this.record.outputPad, width, this.theme);
  }

  invalidate(): void {}
}

/** A call's block on its own, as an export shows each row. A copy: callers may change it. */
function standaloneCell(record: CallRecord, theme: Theme): Cell {
  const cell = EXPLORE.has(record.tool)
    ? exploredCell([record], record.expanded, theme)
    : cellOf(record, theme);
  return { ...cell, body: [...cell.body] };
}

const leaders = new WeakMap<string[], { size: number; leader: string | undefined }>();

/** The first call of a run with a live row, cached per run until rows are added. */
function leaderOf(ids: string[], index: RowIndex): string | undefined {
  const cached = leaders.get(ids);
  if (cached && cached.size === index.size) return cached.leader;
  const leader = ids.find((id) => index.has(id));
  leaders.set(ids, { size: index.size, leader });
  return leader;
}

/** Tools whose results this extension draws itself, unless another extension renders them. */
const OWN_RESULTS = new Set(["bash", "powershell", "read", "edit", "write", "grep", "find", "ls"]);

/** `inner`, two columns in; clicks reach it. */
class Indent implements Component {
  inner: Component;
  private height = 0;

  constructor(inner: Component) {
    this.inner = inner;
  }

  private last: { drawn: string[]; lines: string[] } | undefined;

  render(width: number): string[] {
    const drawn = this.inner.render(Math.max(1, width - 2));
    // The same lines from `inner` give the same lines here, so a row can tell nothing changed.
    if (this.last?.drawn !== drawn) this.last = { drawn, lines: drawn.map((line) => `  ${line}`) };
    this.height = this.last.lines.length;
    return this.last.lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return forwardMouse(this.inner, event, {
      component: this.inner,
      top: 0,
      left: 2,
      height: this.height,
    });
  }

  invalidate(): void {
    this.inner.invalidate();
  }
}

/** What Pi keeps for one row across its call and result slots (`context.state`). */
interface RowState {
  tidy?: CallRecord;
}

/**
 * Renderers for one tool. Each row keeps its record in its own `context.state`, so a rebuilt
 * transcript or an export never shares state with another row; live rows also list themselves in
 * `index`, where runs of reads find their members.
 */
export function createRenderers(
  tool: string,
  inner: ToolRenderers | undefined,
  index: RowIndex,
  timeline: Timeline,
): ToolRenderers {
  const builtin = builtinRenderers(tool);
  // Another extension's result renderer for a built-in tool replaces Tidy's result.
  const custom = customResult(tool, inner);
  const useInnerResult = !!inner?.renderResult && (!OWN_RESULTS.has(tool) || custom);
  // Pi's own call renderers draw nothing Tidy shows and can start work (edit previews).
  // A custom result may rely on state Pi's call renderer sets up, so run it then too.
  const useInnerCall =
    !!inner?.renderCall && (custom || !sameRenderer(inner.renderCall, builtin?.renderCall));
  const record = (context: RenderContext): CallRecord => {
    const state = context.state as RowState;
    let entry = state.tidy;
    if (!entry) {
      entry = {
        id: context.toolCallId,
        tool,
        args: {},
        cwd: context.cwd,
        status: "pending",
        durationMs: undefined,
        result: undefined,
        inner,
        innerCall: undefined,
        innerResult: undefined,
        innerState: {},
        // Pi's live rows first draw before execution starts; an export draws finished calls.
        live: !context.executionStarted,
        expanded: context.expanded,
        piExpanded: context.expanded,
        override: undefined,
        outputPad: 1,
        expandKey: "",
        customResult: custom,
      };
      state.tidy = entry;
    }
    entry.args = (context.args ?? {}) as Args;
    entry.cwd = context.cwd;
    // An export draws each call before its result: call it finished, not running.
    entry.status = entry.live || !context.isPartial ? statusOf(context) : "ok";
    entry.durationMs = context.durationMs;
    if (context.expanded !== entry.piExpanded) {
      entry.piExpanded = context.expanded;
      entry.override = undefined;
    }
    entry.expanded = entry.override ?? entry.piExpanded;
    entry.outputPad = Math.max(0, context.outputPad ?? 1);
    entry.expandKey = context.keyText?.("app.tools.expand") ?? "";
    // Each live row registers once, when Pi creates it: a detached row redrawing later must not
    // displace the current one. A second row for a call means Pi drew the transcript again.
    if (entry.live && !entry.registered) {
      entry.registered = true;
      if (index.register(entry)) timeline.noteRedraw();
    }
    // Tidy draws this call now, even if another renderer drew it before.
    if (entry.live && tool !== "read") index.setApart(entry.id, false);
    return entry;
  };

  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const entry = record(context);
      // Other tools' renderers may set up shared state in their call slot.
      if (inner?.renderCall && useInnerCall) {
        try {
          entry.innerCall = inner.renderCall(args, theme, {
            ...context,
            state: entry.innerState,
            lastComponent: entry.innerCall,
          });
        } catch {
          entry.innerCall = undefined;
        }
      }
      const last = context.lastComponent;
      return last instanceof CallView && last.record === entry
        ? last
        : new CallView(entry, index, timeline, theme);
    },
    renderResult(result, options, theme, context) {
      const entry = record(context);
      entry.result = result;
      // Pi draws an image after the row, under whichever row read it: keep that read apart.
      if (entry.live && tool === "read")
        index.setApart(
          entry.id,
          context.showImages &&
            getCapabilities().images !== null &&
            result.content.some((block) => block.type === "image"),
        );
      if (inner?.renderResult && useInnerResult) {
        try {
          entry.innerResult = inner.renderResult(result, options, theme, {
            ...context,
            state: entry.innerState,
            lastComponent: entry.innerResult,
          });
        } catch {
          entry.innerResult = undefined;
        }
      }
      const last = context.lastComponent;
      return last instanceof BodyView && last.record === entry ? last : new BodyView(entry, theme);
    },
  };
}
