import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFooterStatus } from "../../src/footer-status.ts";
import type { McpManager, McpServerStatus } from "./manager.ts";

export const MCP_STATUS_KEY = "mcp";

export function formatMcpCount(
  servers: Pick<McpServerStatus, "enabled" | "status">[],
): string | undefined {
  if (servers.length === 0) return undefined;
  const connected = servers.filter(
    (server) => server.enabled && server.status === "connected",
  ).length;
  return `mcp ${connected}/${servers.length}`;
}

export function installMcpStatus(ctx: ExtensionContext, manager: McpManager): () => void {
  if (!ctx.hasUI) return () => {};
  let label: string | undefined;
  let published = false;
  let active = true;
  const update = () => {
    if (!active) return;
    const next = formatMcpCount(manager.snapshot());
    if (published && next === label) return;
    label = next;
    published = true;
    setFooterStatus(ctx, MCP_STATUS_KEY, label);
  };
  const unsubscribe = manager.subscribe(update);
  try {
    update();
  } catch (error) {
    active = false;
    unsubscribe();
    throw error;
  }
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    setFooterStatus(ctx, MCP_STATUS_KEY, undefined);
  };
}
