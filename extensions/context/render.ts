import { stripVTControlCharacters } from "node:util";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

// Display only: tool content, evidence warnings, and continuation tokens stay unchanged.
type Args = Record<string, unknown>;
type Result = { content: readonly { type: string; text?: string }[] };
const clean = (value: unknown) =>
  stripVTControlCharacters(typeof value === "string" ? value : "").replace(
    // eslint-disable-next-line no-control-regex -- Remove terminal controls from historical text.
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
const inline = (value: unknown) => clean(value).replace(/\s+/g, " ").trim();
const object = (value: unknown): value is Args =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const output = (result: Result) =>
  result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

// Compute colors on every render so theme changes and terminal resizing are safe.
function view(lines: () => string[], wrap = false): Component {
  return {
    render(width) {
      if (width < 1) return [];
      return wrap
        ? new Text(lines().join("\n"), 0, 0)
            .render(width)
            .map((line) => truncateToWidth(line, width))
        : lines().map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}
const hint = (theme: Theme) => theme.fg("dim", `${keyText("app.tools.expand")} to expand`);

export function renderRecallCall(args: Args, theme: Theme): Component {
  return view(() => {
    const mode = args.entryId ? "read" : args.query ? "search" : "recent";
    const target = args.entryId
      ? inline(args.entryId)
      : args.query
        ? `“${inline(args.query)}”`
        : "";
    const meta = [
      args.offset !== undefined ? `offset ${args.offset}` : "",
      args.limit !== undefined ? `limit ${args.limit}` : "",
      args.cursor ? "next page" : "",
    ].filter(Boolean);
    return [
      theme.fg("toolTitle", theme.bold("recall")) +
        " " +
        theme.fg("muted", mode) +
        (target ? " " + theme.fg("accent", target) : "") +
        (meta.length ? theme.fg("dim", ` · ${meta.join(" · ")}`) : ""),
    ];
  });
}

export function renderRecallResult(
  result: Result,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  isError = false,
): Component {
  const raw = output(result);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    /* Errors and older text-only results. */
  }
  const record = object(data) ? data : undefined;
  return view(() => {
    if (options.isPartial) return [theme.fg("muted", "Recalling evidence…")];
    if (isError || !record) return [theme.fg(isError ? "error" : "toolOutput", clean(raw))];
    const lines: string[] = [];
    if (typeof record.text === "string") {
      lines.push(
        theme.fg("accent", inline(record.entryId)) +
          theme.fg("muted", ` · ${inline(record.role)}`) +
          theme.fg("dim", ` · ${record.totalChars} chars`),
      );
      const body = clean(record.text).split("\n");
      lines.push(
        ...(options.expanded ? body : body.slice(0, 3)).map((line) => theme.fg("toolOutput", line)),
      );
      if (!options.expanded) lines.push(hint(theme));
      if (record.nextOffset != null)
        lines.push(theme.fg("warning", `More text available · next offset ${record.nextOffset}`));
    } else if (Array.isArray(record.results)) {
      const entries = record.results.filter(object);
      const notes = Array.isArray(record.notes) ? record.notes.filter(object) : [];
      lines.push(
        theme.fg(
          "muted",
          `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${notes.length} saved ${notes.length === 1 ? "note" : "notes"}${record.nextCursor ? " · more available" : ""}`,
        ),
      );
      for (const entry of options.expanded ? entries : entries.slice(0, 3)) {
        lines.push(
          theme.fg("accent", inline(entry.entryId)) +
            theme.fg(
              entry.isError ? "error" : "muted",
              ` · ${inline(entry.toolName || entry.role)}`,
            ) +
            (options.expanded ? theme.fg("dim", ` · ${inline(entry.timestamp)}`) : ""),
        );
        lines.push(
          ...(options.expanded ? clean(entry.snippet).split("\n") : [inline(entry.snippet)]).map(
            (line) => theme.fg("toolOutput", `  ${line}`),
          ),
        );
      }
      if (options.expanded && notes.length) {
        lines.push(theme.fg("muted", "Saved notes"));
        lines.push(
          ...notes.map(
            (note) =>
              theme.fg("accent", inline(note.name)) + theme.fg("dim", ` · ${inline(note.entryId)}`),
          ),
        );
      }
      if (!options.expanded && (entries.length || notes.length)) lines.push(hint(theme));
    } else return [theme.fg("toolOutput", clean(raw))];
    if (options.expanded) {
      if (record.timestamp) lines.push(theme.fg("dim", inline(record.timestamp)));
      if (record.nextCursor)
        lines.push(theme.fg("dim", `Next cursor: ${inline(record.nextCursor)}`));
      if (record.warning) lines.push(theme.fg("dim", clean(record.warning)));
    }
    return lines;
  }, options.expanded || isError);
}

export function renderNotesCall(args: Args, theme: Theme): Component {
  return view(() => [
    theme.fg("toolTitle", theme.bold("notes")) +
      " " +
      theme.fg("muted", inline(args.action)) +
      (args.name ? " " + theme.fg("accent", inline(args.name)) : "") +
      (args.reset ? theme.fg("dim", " · fresh window requested") : ""),
  ]);
}

export function renderNotesResult(
  result: Result,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  isError = false,
): Component {
  return view(() => {
    if (options.isPartial) return [theme.fg("muted", "Saving…")];
    const raw = clean(output(result));
    // Preserve checkpoint caveats: requested is not the same as completed.
    const compact = raw.replace(/\. Read this entryId with recall\.$/, ".");
    return [
      theme.fg(isError ? "error" : "success", isError ? "" : "✓ ") +
        theme.fg(isError ? "error" : "muted", options.expanded ? raw : compact),
    ];
  }, true);
}
