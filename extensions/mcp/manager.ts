import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  defaultMcpConfigPaths,
  loadMcpConfig,
  mcpToolName,
  type McpConfigPaths,
  type ResolvedMcpServer,
  setServerDisabled,
} from "./config.ts";
import { connectMcpServer, mcpPromptSnippet, type ConnectedMcpServer } from "./connect.ts";

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  status: "connected" | "connecting" | "failed" | "disconnected";
  error?: string;
  tools: Array<{ name: string; description: string }>;
  source: string;
  type: ResolvedMcpServer["type"];
}

export class McpManager {
  private config: ResolvedMcpServer[] = [];
  private overlayPath = "";
  private generation = 0;
  private readonly sessions = new Map<string, ConnectedMcpServer>();
  private readonly errors = new Map<string, string>();
  private readonly connecting = new Set<string>();
  private readonly registered = new Map<string, Set<string>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pi: ExtensionAPI;
  private readonly connectServer: (server: ResolvedMcpServer) => Promise<ConnectedMcpServer>;

  constructor(
    pi: ExtensionAPI,
    connectServer: (server: ResolvedMcpServer) => Promise<ConnectedMcpServer> = connectMcpServer,
  ) {
    this.pi = pi;
    this.connectServer = connectServer;
  }

  snapshot(): McpServerStatus[] {
    return this.config.map((server) => {
      const session = this.sessions.get(server.name);
      const error = this.errors.get(server.name);
      const status: McpServerStatus["status"] = this.connecting.has(server.name)
        ? "connecting"
        : session
          ? "connected"
          : error
            ? "failed"
            : "disconnected";
      const tools =
        session?.tools.map((tool) => ({ name: tool.name, description: tool.description })) ?? [];
      const item: McpServerStatus = {
        name: server.name,
        enabled: server.enabled,
        status,
        tools,
        source: server.source,
        type: server.type,
      };
      if (error) item.error = error;
      return item;
    });
  }

  async start(ctx: ExtensionContext, paths?: McpConfigPaths): Promise<void> {
    await this.stop();
    const generation = this.generation;
    const loaded = await loadMcpConfig(paths ?? defaultMcpConfigPaths(ctx.cwd), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    this.config = loaded.servers;
    this.overlayPath = loaded.overlayPath;
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    await Promise.all(
      this.config
        .filter((server) => server.enabled)
        .map((server) => this.enqueue(server.name, () => this.connect(server, ctx, generation))),
    );
  }

  async stop(): Promise<void> {
    this.generation += 1;
    for (const name of this.registered.keys()) this.deactivateTools(name);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.errors.clear();
    this.connecting.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async setEnabled(name: string, enabled: boolean, ctx: ExtensionContext): Promise<void> {
    const server = this.config.find((candidate) => candidate.name === name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    await this.enqueue(name, async () => {
      await setServerDisabled(this.overlayPath, name, !enabled);
      server.enabled = enabled;
      if (enabled) await this.connect(server, ctx, this.generation);
      else await this.disconnect(server);
    });
  }

  private enqueue(name: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  }

  private async connect(
    server: ResolvedMcpServer,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    if (this.generation !== generation || !server.enabled) return;
    this.connecting.add(server.name);
    this.errors.delete(server.name);
    try {
      await this.disconnect(server);
      if (this.generation !== generation || !server.enabled) return;
      const session = await this.connectServer(server);
      if (this.generation !== generation || !server.enabled) {
        await session.close();
        return;
      }
      this.sessions.set(server.name, session);
      this.registerTools(server.name, session);
    } catch (error) {
      this.errors.set(server.name, error instanceof Error ? error.message : String(error));
      ctx.ui.notify(`MCP ${server.name}: ${this.errors.get(server.name)}`, "error");
    } finally {
      this.connecting.delete(server.name);
    }
  }

  private async disconnect(server: ResolvedMcpServer): Promise<void> {
    const session = this.sessions.get(server.name);
    this.sessions.delete(server.name);
    this.deactivateTools(server.name);
    if (session) await session.close();
  }

  private registerTools(serverName: string, session: ConnectedMcpServer): void {
    const names = new Set<string>();
    for (const tool of session.tools) {
      const name = mcpToolName(serverName, tool.name);
      names.add(name);
      if (this.registered.get(serverName)?.has(name)) continue;
      const snippet = mcpPromptSnippet(tool.description, `${serverName} ${tool.name}`);
      this.pi.registerTool({
        name,
        label: `${serverName} ${tool.name}`,
        description: tool.description,
        promptSnippet: snippet,
        parameters: tool.inputSchema,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
          const live = this.sessions.get(serverName);
          if (!live) throw new Error(`MCP server ${serverName} is disconnected.`);
          const result = await live.call(tool.name, params, signal);
          if (result.isError) throw new Error(result.text);
          return {
            content: [{ type: "text", text: result.text }],
            details: { server: serverName, tool: tool.name },
          };
        },
        renderCall: (_args, theme) =>
          new Text(
            `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", serverName)}`,
            0,
            0,
          ),
        renderResult: (result, _options, theme) => {
          const text = result.content.find((item) => item.type === "text");
          const body = text?.type === "text" ? text.text : "";
          return new Text(theme.fg("toolOutput", body), 0, 0);
        },
      });
    }
    this.registered.set(serverName, names);
    this.setToolsActive(serverName, true);
  }

  private deactivateTools(serverName: string): void {
    this.setToolsActive(serverName, false);
  }

  private setToolsActive(serverName: string, enabled: boolean): void {
    const names = this.registered.get(serverName);
    if (!names || names.size === 0) return;
    const active = this.pi.getActiveTools();
    const next = enabled
      ? [...new Set([...active, ...names])]
      : active.filter((name) => !names.has(name));
    this.pi.setActiveTools(next);
  }
}
