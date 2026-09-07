import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { McpServerStatus, McpToolSummary } from "./manager.ts";

export function estimateToolTokens(tool: McpToolSummary): number {
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? { type: "object" },
  });
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function estimateServerTokens(server: Pick<McpServerStatus, "tools">): number {
  return server.tools.reduce((sum, tool) => sum + estimateToolTokens(tool), 0);
}

export function estimateEnabledMcpTokens(servers: McpServerStatus[]): number {
  return servers
    .filter((server) => server.enabled)
    .reduce((sum, server) => sum + estimateServerTokens(server), 0);
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 10_000) {
    const tenths = Math.round(tokens / 100) / 10;
    return `${tenths}k`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export function statusLabel(status: McpServerStatus["status"]): string {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "failed":
      return "failed";
    default:
      return "disconnected";
  }
}

export function serverDescription(
  server: McpServerStatus,
  enabledTotalTokens = estimateEnabledMcpTokens([server]),
): string {
  const status = statusLabel(server.status);
  const parts = [status];
  if (server.status === "failed" && server.error) parts.push(server.error);
  if (server.tools.length > 0) {
    parts.push(`${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`);
    const serverTokens = estimateServerTokens(server);
    parts.push(`~${formatTokenCount(serverTokens)} tokens`);
    if (server.enabled && enabledTotalTokens > serverTokens) {
      parts.push(`~${formatTokenCount(enabledTotalTokens)} enabled`);
    }
  } else if (server.status === "connected") {
    parts.push("no tools");
  }
  return parts.join(" · ");
}

export function buildMcpSettingItems(servers: McpServerStatus[]): SettingItem[] {
  const enabledTotalTokens = estimateEnabledMcpTokens(servers);
  return servers.map((server) => ({
    id: server.name,
    label: server.name,
    currentValue: server.enabled ? "enabled" : "disabled",
    values: ["enabled", "disabled"],
    description: serverDescription(server, enabledTotalTokens),
  }));
}

export async function showMcpPanel(
  ctx: ExtensionCommandContext,
  readServers: () => McpServerStatus[],
  onToggle: (name: string, enabled: boolean) => Promise<void>,
  subscribe: (listener: () => void) => () => void = () => () => {},
): Promise<void> {
  if (ctx.mode === "tui") {
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const container = new Container();
      const border = (text: string) => theme.fg("border", text);
      let open = true;
      container.addChild(new DynamicBorder(border));

      const items = buildMcpSettingItems(readServers());
      const settingsList = new SettingsList(
        items,
        10,
        getSettingsListTheme(),
        (id, newValue) => {
          void onToggle(id, newValue === "enabled")
            .catch((error: unknown) => {
              if (open)
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            })
            .finally(update);
        },
        () => done(undefined),
        { enableSearch: true },
      );
      const update = () => {
        if (!open) return;
        const updated = buildMcpSettingItems(readServers());
        for (const item of items) {
          const next = updated.find((candidate) => candidate.id === item.id);
          if (!next) continue;
          item.currentValue = next.currentValue;
          if (next.description) item.description = next.description;
          else delete item.description;
          settingsList.updateValue(item.id, item.currentValue);
        }
        tui.requestRender();
      };
      const unsubscribe = subscribe(update);
      container.addChild(settingsList);
      container.addChild(new DynamicBorder(border));
      return {
        dispose() {
          open = false;
          unsubscribe();
        },
        render: (width: number) => container.render(width),
        invalidate: () => {
          container.invalidate();
          settingsList.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
    return;
  }

  const servers = readServers();
  if (!ctx.hasUI) return;
  if (servers.length === 0) {
    ctx.ui.notify("No MCP servers configured.", "warning");
    return;
  }

  const selected = await ctx.ui.select(
    "MCP",
    servers.map((server) => {
      const tokens = estimateServerTokens(server);
      const tokenLabel = server.tools.length > 0 ? `  ~${formatTokenCount(tokens)} tokens` : "";
      return `${server.name}  ${server.enabled ? "enabled" : "disabled"}  ${statusLabel(server.status)}${tokenLabel}`;
    }),
  );
  if (!selected) return;
  const name = selected.split(/\s+/, 1)[0];
  const server = servers.find((candidate) => candidate.name === name);
  if (!server) return;
  const next = await ctx.ui.select(
    server.name,
    server.enabled ? ["Disable", "Keep enabled"] : ["Enable", "Keep disabled"],
  );
  if (next === "Enable") await onToggle(server.name, true);
  else if (next === "Disable") await onToggle(server.name, false);
}

export function formatStatusText(servers: McpServerStatus[]): string {
  if (servers.length === 0) return "No MCP servers configured.";
  const enabledTokens = estimateEnabledMcpTokens(servers);
  const tokenLine = enabledTokens > 0 ? `\n~${formatTokenCount(enabledTokens)} tokens enabled` : "";
  return (
    servers
      .map(
        (server) =>
          `${server.name}: ${server.enabled ? "enabled" : "disabled"} (${statusLabel(server.status)})`,
      )
      .join("\n") + tokenLine
  );
}
