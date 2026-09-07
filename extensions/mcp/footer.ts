import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFooterDecorator } from "../../src/footer-decorator.ts";
import type { McpManager, McpServerStatus } from "./manager.ts";

export const MCP_STATUS_KEY = "mcp";

export function formatMcpCount(
  servers: Pick<McpServerStatus, "enabled" | "status">[],
): string | undefined {
  if (servers.length === 0) return undefined;
  const connected = servers.filter(
    (server) => server.enabled && server.status === "connected",
  ).length;
  return `mcp (${connected}/${servers.length})`;
}

/** Add to the stats/model gap, never displacing Pi's own information or adding a row. */
export function appendMcpCount(lines: string[], label: string | undefined): string[] {
  const line = lines[1];
  if (!label || !line || /mcp \(\d+\/\d+\)/.test(line)) return lines;
  const gap = / {2,}/.exec(line);
  // Reserve separation for the model and the Fast Mode glyph, in either load order.
  if (!gap || gap[0].length < label.length + 5) return lines;
  const result = [...lines];
  result[1] = line.slice(0, gap.index) + ` ${label}` + line.slice(gap.index + label.length + 1);
  return result;
}

export function installMcpStatus(ctx: ExtensionContext, manager: McpManager): () => void {
  if (!ctx.hasUI) return () => {};
  let label: string | undefined;
  let published = false;
  let active = true;
  const removeFooter =
    ctx.mode === "tui"
      ? installFooterDecorator(ctx.sessionManager, (lines) => appendMcpCount(lines, label))
      : () => {};
  const update = () => {
    if (!active) return;
    const next = formatMcpCount(manager.snapshot());
    if (published && next === label) return;
    label = next;
    published = true;
    // Clearing our TUI status requests a native redraw without creating a status row.
    ctx.ui.setStatus(MCP_STATUS_KEY, ctx.mode === "tui" ? undefined : label);
  };
  const unsubscribe = manager.subscribe(update);
  try {
    update();
  } catch (error) {
    active = false;
    unsubscribe();
    removeFooter();
    throw error;
  }
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    removeFooter();
    ctx.ui.setStatus(MCP_STATUS_KEY, undefined);
  };
}
