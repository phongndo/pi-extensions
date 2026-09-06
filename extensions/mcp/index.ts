import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { McpManager } from "./manager.ts";
import { showMcpPanel } from "./ui.ts";

export default function mcpExtension(pi: ExtensionAPI): void {
  const manager = new McpManager(pi);

  pi.registerCommand("mcp", {
    description: "Enable or disable MCP servers",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/mcp does not take arguments.", "warning");
        return;
      }
      await showMcpPanel(
        ctx,
        () => manager.snapshot(),
        (name, enabled) => manager.setEnabled(name, enabled, ctx),
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await manager.start(ctx);
  });

  pi.on("session_shutdown", async () => {
    await manager.stop();
  });
}
