import { stripVTControlCharacters } from "node:util";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

const PREVIEW_LINES = 4;
type Result = {
  content: readonly { type: string; text?: string }[];
  details?: unknown;
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const clean = (text: string) =>
  stripVTControlCharacters(text).replace(
    // eslint-disable-next-line no-control-regex -- Historical/server text must not control the terminal.
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
const inline = (text: string) => clean(text).replace(/\s+/g, " ").trim();
const expandHint = () => `${keyText("app.tools.expand")} to expand`;

function summary(value: unknown): string {
  if (typeof value === "string") return inline(value);
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (object(value)) return `{${Object.keys(value).length} fields}`;
  return String(value);
}
function pretty(text: string): { text: string; value?: unknown; json: boolean } {
  try {
    const value: unknown = JSON.parse(text);
    let depth = 0;
    // Inspect lexical tokens, not parsed numbers: JSON.parse can silently round IDs
    // or turn huge exponents into Infinity. Deep input must not allocate quadratic
    // indentation in JSON.stringify (including when the result is collapsed).
    for (const [token] of text.matchAll(
      /"(?:\\[\s\S]|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\]]/g,
    )) {
      if (token === "{" || token === "[") {
        if (++depth > 16) return { text, json: false };
      } else if (token === "}" || token === "]") depth--;
      else if (token[0] !== '"' && JSON.stringify(Number(token)) !== token)
        return { text, json: false };
    }
    const formatted = JSON.stringify(value, null, 2);
    if (formatted.length > Math.max(1024, text.length * 4)) return { text, json: false };
    return { text: formatted, value, json: true };
  } catch {
    return { text, json: false };
  }
}
function jsonPreview(value: unknown): string[] {
  if (object(value))
    return Object.keys(value).length
      ? Object.entries(value).map(([key, value]) => `${inline(key)}: ${summary(value)}`)
      : ["{}"];
  if (Array.isArray(value) && !value.length) return ["[]"];
  if (Array.isArray(value))
    return value.map((item, index) => {
      const text = object(item)
        ? Object.entries(item)
            .slice(0, 3)
            .map(([key, value]) => `${inline(key)}: ${summary(value)}`)
            .join(" · ")
        : summary(item);
      return `${index + 1}. ${text}`;
    });
  return [summary(value)];
}

export function renderMcpCall(
  server: string,
  tool: string,
  args: unknown,
  theme: Theme,
  expanded = false,
): Component {
  return {
    render(width) {
      if (width < 1) return [];
      const title =
        theme.fg("toolTitle", theme.bold(inline(server))) +
        theme.fg("dim", " / ") +
        theme.fg("toolTitle", theme.bold(inline(tool)));
      const entries = object(args) ? Object.entries(args) : [];
      if (expanded && entries.length) {
        return [
          truncateToWidth(title, width),
          ...new Text(theme.fg("muted", clean(pretty(JSON.stringify(args)).text)), 0, 0).render(
            width,
          ),
        ].map((line) => truncateToWidth(line, width));
      }
      const preview = entries
        .slice(0, 2)
        .map(([key, value]) => `${inline(key)}=${summary(value)}`)
        .join(" · ");
      const extra = entries.length > 2 ? ` · +${entries.length - 2} args` : "";
      return [
        truncateToWidth(title + (preview ? " " + theme.fg("muted", preview + extra) : ""), width),
      ];
    },
    invalidate() {},
  };
}

export function renderMcpResult(
  result: Result,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  isError = false,
): Component {
  // Presentation only: retain the original content, images, and details for Pi/model consumers.
  const blocks = result.content
    .filter((block) => block.type === "text")
    .map((block) => pretty(block.text ?? ""));
  const imageCount = result.content.filter((block) => block.type === "image").length;
  const fullOutputPath =
    object(result.details) && typeof result.details.fullOutputPath === "string"
      ? result.details.fullOutputPath
      : undefined;
  return {
    render(width) {
      if (width < 1) return [];
      const color = isError ? "error" : "toolOutput";
      const lines: string[] = [];
      if (options.isPartial) lines.push(theme.fg("muted", "Receiving MCP result…"));
      if (isError) lines.push(theme.fg("error", "Error"));
      const all = blocks.flatMap((block) => clean(block.text).split("\n"));
      if (options.expanded) {
        lines.push(
          ...new Text(all.map((line) => theme.fg(color, line)).join("\n"), 0, 0).render(width),
        );
      } else {
        const preview = blocks.flatMap((block) =>
          block.json ? jsonPreview(block.value) : clean(block.text).split("\n"),
        );
        const shown = preview.slice(0, PREVIEW_LINES);
        lines.push(...shown.map((line) => theme.fg(color, line)));
        const remaining = preview.length - shown.length;
        if (
          remaining > 0 ||
          blocks.some((block) => block.json) ||
          shown.some((line) => visibleWidth(line) > width)
        ) {
          lines.push(
            theme.fg("dim", `${remaining > 0 ? `${remaining} more lines · ` : ""}${expandHint()}`),
          );
        }
      }
      if (!all.some((line) => line.trim()) && !imageCount && !options.isPartial)
        lines.push(theme.fg("dim", "No output"));
      if (imageCount)
        lines.push(
          theme.fg(
            "muted",
            `${imageCount} ${imageCount === 1 ? "image" : "images"} · displayed by Pi when enabled`,
          ),
        );
      if (fullOutputPath) {
        lines.push(
          ...new Text(
            theme.fg("warning", `Output truncated · full output: ${clean(fullOutputPath)}`),
            0,
            0,
          ).render(width),
        );
      } else if (!options.expanded) {
        // Thrown tool errors do not carry details; retain the truncation footer in that path too.
        const footer = all.find(
          (line) => line.includes("[Output truncated to ") && line.includes("Full output:"),
        );
        if (footer) lines.push(...new Text(theme.fg("warning", footer), 0, 0).render(width));
      }
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}
