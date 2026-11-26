import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
export type RenderContext = Parameters<RenderCall>[2];
export type ToolResult = Parameters<RenderResult>[0];
export type Args = Record<string, unknown>;

/**
 * Tool text and arguments come from commands and models: drop escape sequences and control
 * characters before styling, as Pi's own renderers do, so output cannot move the cursor or restyle
 * the terminal.
 */
export function sanitize(text: string): string {
  // Most output holds no controls, and escape sequences start with one: nothing to drop.
  if (!UNSAFE.test(text)) return text;
  let out = "";
  for (const char of stripVTControlCharacters(text)) {
    if (char === "\t") out += "   ";
    else if (char === "\n" || !isControl(char.codePointAt(0)!)) out += char;
  }
  return out;
}

/** C0 and C1 controls, DEL, and the interlinear annotation characters. */
const isControl = (code: number) =>
  code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xfff9 && code <= 0xfffb);

/** Any character `sanitize` would change: the controls above, tab included, newline not. */
// oxlint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\ufff9-\ufffb]/;

/** A single-line field, such as a path: a line break inside it shows as `\n`. */
export const oneLine = (text: string): string => text.replace(/\n/g, "\\n");

export const str = (value: unknown): string => (typeof value === "string" ? sanitize(value) : "");
export const num = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

export function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Paths inside the working directory print relative to it, others relative to home. */
export function displayPath(path: string, cwd: string): string {
  return oneLine(shortPath(path, cwd));
}

function shortPath(path: string, cwd: string): string {
  if (!path) return ".";
  if (isAbsolute(path)) {
    if (path === cwd) return ".";
    const inside = relative(cwd, path);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return inside;
    const home = homedir();
    if (path === home || path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  }
  return path;
}

/** `mcp__server__tool` reads as `server · tool`. */
export function displayName(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : tool;
}

/** One-line description of arbitrary arguments, for tools this extension does not know. */
export function summarizeArgs(args: unknown): string {
  if (args == null || typeof args !== "object")
    return args == null ? "" : oneLine(sanitize(String(args)));
  const entries = Object.entries(args as Args).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  const flat = (value: unknown) =>
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : JSON.stringify(value);
  if (entries.length === 1 && typeof entries[0]![1] === "string")
    return sanitize(flat(entries[0]![1]));
  // Keys can hold line breaks too: keep the summary on one line.
  return oneLine(
    sanitize(
      entries
        .map(([key, value]) => `${key}: ${flat(value)}`)
        .join(", ")
        .slice(0, 400),
    ),
  );
}

export function lineRange(args: Args): string {
  const offset = num(args.offset);
  const limit = num(args.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

export function resultText(result: ToolResult | undefined): string {
  if (!result) return "";
  return sanitize(
    result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n"),
  );
}

export interface ShellOutput {
  lines: string[];
  /** Why the command failed, from the status line Pi appends to failed results. */
  failure?: string;
  /** Pi's `[Showing lines …. Full output: …]` note on truncated output. */
  notice?: string;
  /** Pi's status line as recorded, for the expanded view. */
  status?: string;
}

const SHELL_STATUS =
  /(?:^|\n\n)(Command exited with code (\d+)|Command timed out after (\d+(?:\.\d+)?) seconds[^\n]*|Command aborted|Command terminated without an exit code)\s*$/;
export const NOTICE = /(?:^|\n\n)\[(?:Showing|Truncated|\d+ more lines)[^\n]*\]\s*$/;
/** Any `[…]` note Pi's search tools append after a blank line: limits, truncation. */
const TRAILING_NOTE = /\n\n\[[^\n]*\]\s*$/;

/** Result lines without the trailing note and blank lines. */
export function contentLines(text: string): string[] {
  return text
    .replace(TRAILING_NOTE, "")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

const MARK = /([:-])(\d+)\1 /g;

interface GrepReading {
  prefix: string;
  kind: "match" | "context";
  line: number;
}

/** Every way to read a grep line: a path, then `:N: ` for a match or `-N- ` for context. */
function readings(line: string): GrepReading[] {
  return [...line.matchAll(MARK)].map((mark) => ({
    prefix: line.slice(0, mark.index),
    kind: mark[1] === ":" ? "match" : "context",
    line: Number(mark[2]),
  }));
}

/**
 * Matches in grep output. Without context lines every line is a match. With them, Pi prints
 * matches as `path:line: text` and context as `path-line- text`. A path or text can contain
 * either marker, so each line is read with the path most lines share, and on a tie with the path
 * whose line numbers run on from a neighbor's. Output in another format counts every line.
 */
export function countMatches(text: string, withContext = true): number {
  const lines = contentLines(text);
  if (!withContext) return lines.length;
  const options = lines.map(readings);
  if (options.every((list) => list.length === 0)) return lines.length;
  const frequency = new Map<string, number>();
  for (const list of options)
    for (const prefix of new Set(list.map((reading) => reading.prefix)))
      frequency.set(prefix, (frequency.get(prefix) ?? 0) + 1);
  const runsOn = (reading: GrepReading, at: number) =>
    [options[at - 1], options[at + 1]].some((neighbor) =>
      neighbor?.some(
        (other) =>
          other.prefix === reading.prefix &&
          Math.abs(other.line - reading.line) >= 1 &&
          Math.abs(other.line - reading.line) <= 50,
      ),
    );
  let matches = 0;
  options.forEach((list, at) => {
    let best: GrepReading | undefined;
    let bestScore = -1;
    for (const reading of list) {
      const score = (frequency.get(reading.prefix) ?? 0) * 2 + (runsOn(reading, at) ? 1 : 0);
      if (score > bestScore) {
        best = reading;
        bestScore = score;
      }
    }
    if (best?.kind === "match") matches++;
  });
  return matches;
}

/**
 * Split Pi's bash result into output lines, its truncation note, and the status it appends to
 * failed results. Only a failed result has that status: in a successful one the same words are
 * the command's own output.
 */
export function parseShellOutput(text: string, isError: boolean): ShellOutput {
  let output = text;
  let failure: string | undefined;
  let notice: string | undefined;
  let statusText: string | undefined;
  const status = isError ? SHELL_STATUS.exec(output) : null;
  if (status) {
    output = output.slice(0, status.index);
    statusText = status[1]!.trim();
    failure = status[2]
      ? `exit ${status[2]}`
      : status[3]
        ? `timed out after ${status[3]}s`
        : status[1] === "Command aborted"
          ? "aborted"
          : "no exit code";
  }
  const note = NOTICE.exec(output);
  if (note) {
    notice = note[0].trim();
    output = output.slice(0, note.index);
  }
  output = output.trimEnd();
  if (output.trim() === "(no output)") output = "";
  const lines = output === "" ? [] : output.replace(/^\n+/, "").split("\n");
  return {
    lines,
    ...(failure ? { failure } : {}),
    ...(notice ? { notice } : {}),
    ...(statusText ? { status: statusText } : {}),
  };
}
