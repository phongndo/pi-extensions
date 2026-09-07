import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpConfigPaths } from "./config.ts";
import type { connectMcpServer } from "./connect.ts";
import { installMcpStatus } from "./footer.ts";
import { McpManager } from "./manager.ts";
import { showMcpPanel } from "./ui.ts";

export function createMcpExtension(
  options: { paths?: McpConfigPaths; connect?: typeof connectMcpServer } = {},
) {
  return function mcpExtension(pi: ExtensionAPI): void {
    const manager = new McpManager(pi, options.connect);
    let removeStatus = () => {};

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
          (listener) => manager.subscribe(listener),
        );
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      removeStatus();
      removeStatus = () => {};
      try {
        removeStatus = installMcpStatus(ctx, manager);
      } catch {
        ctx.ui.notify("MCP footer indicator unavailable; /mcp still works.", "warning");
      }
      await manager.start(ctx, options.paths);
    });

    pi.on("session_shutdown", async () => {
      removeStatus();
      removeStatus = () => {};
      await manager.stop();
    });
  };
}

export default createMcpExtension();
