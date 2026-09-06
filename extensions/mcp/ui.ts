import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { McpServerStatus } from "./manager.ts";

type Theme = ExtensionContext["ui"]["theme"];

export function settingsListTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
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

export function serverDescription(server: McpServerStatus): string {
  const status = statusLabel(server.status);
  const tools =
    server.tools.length > 0
      ? `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
      : "no tools";
  if (server.status === "failed" && server.error) return `${status} · ${server.error}`;
  if (server.status === "connected") return `${status} · ${tools}`;
  return status;
}

export function buildMcpSettingItems(servers: McpServerStatus[]): SettingItem[] {
  return servers.map((server) => ({
    id: server.name,
    label: server.name,
    currentValue: server.enabled ? "enabled" : "disabled",
    values: ["enabled", "disabled"],
    description: serverDescription(server),
  }));
}

export async function showMcpPanel(
  ctx: ExtensionCommandContext,
  readServers: () => McpServerStatus[],
  onToggle: (name: string, enabled: boolean) => Promise<void>,
): Promise<void> {
  if (ctx.mode === "tui") {
    await ctx.ui.custom((tui, theme, keybindings, done) => {
      const container = new Container();
      const border = (text: string) => theme.fg("border", text);
      container.addChild(new DynamicBorder(border));
      container.addChild(new Text(theme.fg("accent", theme.bold("MCP")), 1, 0));
      container.addChild(new Spacer(1));

      const items = buildMcpSettingItems(readServers());
      if (items.length === 0) {
        container.addChild(new Text(theme.fg("muted", "No MCP servers configured."), 1, 0));
        container.addChild(
          new Text(
            theme.fg("dim", "Add servers to ~/.config/mcp/mcp.json or ~/.pi/agent/mcp.json"),
            1,
            0,
          ),
        );
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "  Esc to close"), 1, 0));
        container.addChild(new DynamicBorder(border));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data: string) {
            if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
          },
        };
      }

      const settingsList = new SettingsList(
        items,
        Math.min(Math.max(items.length, 1), 12),
        settingsListTheme(theme),
        (id, newValue) => {
          void onToggle(id, newValue === "enabled")
            .catch((error: unknown) => {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            })
            .finally(() => {
              const updated = buildMcpSettingItems(readServers());
              for (const item of items) {
                const next = updated.find((candidate) => candidate.id === item.id);
                if (!next) continue;
                item.currentValue = next.currentValue;
                if (next.description) item.description = next.description;
                else delete item.description;
              }
              tui.requestRender();
            });
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(new DynamicBorder(border));
      return {
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
  if (!ctx.hasUI) {
    ctx.ui.notify(formatStatusText(servers), "info");
    return;
  }
  if (servers.length === 0) {
    ctx.ui.notify("No MCP servers configured.", "warning");
    return;
  }

  const selected = await ctx.ui.select(
    "MCP",
    servers.map(
      (server) =>
        `${server.name}  ${server.enabled ? "enabled" : "disabled"}  ${statusLabel(server.status)}`,
    ),
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
  return servers
    .map(
      (server) =>
        `${server.name}: ${server.enabled ? "enabled" : "disabled"} (${statusLabel(server.status)})`,
    )
    .join("\n");
}
