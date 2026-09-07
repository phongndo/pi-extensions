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
import { limitMcpOutput } from "./output.ts";

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  status: "connected" | "connecting" | "failed" | "disconnected";
  error?: string;
  tools: McpToolSummary[];
  source: string;
  type: ResolvedMcpServer["type"];
}

export class McpManager {
  private config: ResolvedMcpServer[] = [];
  private overlayPath = "";
  private generation = 0;
  private running = false;
  private lifetime = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Map<string, () => void>();
  private readonly sessions = new Map<string, ConnectedMcpServer>();
  private readonly errors = new Map<string, string>();
  private readonly connecting = new Set<string>();
  private readonly registered = new Map<string, Set<string>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly desiredEnabled = new Map<string, boolean>();
  private readonly lastTools = new Map<string, McpToolSummary[]>();
  private readonly pi: ExtensionAPI;
  private readonly connectServer: typeof connectMcpServer;

  constructor(pi: ExtensionAPI, connectServer: typeof connectMcpServer = connectMcpServer) {
    this.pi = pi;
    this.connectServer = connectServer;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A disposed UI must not interrupt client cleanup. */
      }
    }
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
      const tools = session
        ? session.tools.map((tool) => summarizeTool(tool))
        : (this.lastTools.get(server.name) ?? []);
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
    const pending = new Map(this.desiredEnabled);
    const stopped = this.stop();
    const generation = this.generation;
    await stopped;
    if (generation !== this.generation) return;
    const loaded = await loadMcpConfig(paths ?? defaultMcpConfigPaths(ctx.cwd));
    if (generation !== this.generation) return;
    this.lifetime = new AbortController();
    this.running = true;
    this.config = loaded.servers;
    for (const server of this.config) {
      const desired = this.desiredEnabled.get(server.name) ?? pending.get(server.name);
      if (desired !== undefined) server.enabled = desired;
    }
    this.overlayPath = loaded.overlayPath;
    this.changed();
    for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    await Promise.all(
      this.config
        .filter((server) => server.enabled)
        .map((server) => this.enqueue(server.name, () => this.connect(server, ctx, generation))),
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    this.lifetime.abort();
    for (const unsubscribe of this.closeListeners.values()) unsubscribe();
    this.closeListeners.clear();
    for (const name of this.registered.keys()) this.deactivateTools(name);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.errors.clear();
    this.connecting.clear();
    this.changed();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }

  async setEnabled(name: string, enabled: boolean, ctx: ExtensionContext): Promise<void> {
    if (!this.running) throw new Error("MCP has no active session.");
    const server = this.config.find((candidate) => candidate.name === name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    const generation = this.generation;
    const overlayPath = this.overlayPath;
    this.desiredEnabled.set(name, enabled);
    await this.enqueue(name, async () => {
      const desired = this.desiredEnabled.get(name);
      if (desired === undefined) return;
      try {
        // An already-requested preference write may finish after shutdown, but
        // its old command context must never reconnect or touch the new runtime.
        await setServerDisabled(overlayPath, name, !desired);
        if (generation !== this.generation || !this.running) return;
        server.enabled = desired;
        if (desired) await this.connect(server, ctx, generation);
        else await this.disconnect(server);
        this.changed();
      } finally {
        if (this.desiredEnabled.get(name) === desired) this.desiredEnabled.delete(name);
      }
    });
  }

  private enqueue(name: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(name) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.queues.set(name, settled);
    void settled.then(() => {
      if (this.queues.get(name) === settled) this.queues.delete(name);
    });
    return next;
  }

  private async connect(
    server: ResolvedMcpServer,
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> {
    const current = () => this.generation === generation && this.running;
    const wanted = () =>
      current() && server.enabled && this.desiredEnabled.get(server.name) !== false;
    if (!wanted() || this.sessions.has(server.name)) return;
    const signal = this.lifetime.signal;
    this.connecting.add(server.name);
    this.errors.delete(server.name);
    this.changed();
    try {
      await this.disconnect(server);
      if (!wanted()) return;
      const session = await this.connectServer(server, signal);
      if (!wanted()) {
        await session.close();
        return;
      }
      this.sessions.set(server.name, session);
      const unsubscribe = session.onClose?.(() => {
        if (!current() || this.sessions.get(server.name) !== session) return;
        this.closeListeners.get(server.name)?.();
        this.closeListeners.delete(server.name);
        this.sessions.delete(server.name);
        this.deactivateTools(server.name);
        this.changed();
      });
      if (this.sessions.get(server.name) !== session) {
        unsubscribe?.();
        await session.close();
        return;
      }
      if (unsubscribe) this.closeListeners.set(server.name, unsubscribe);
      this.registerTools(server.name, session);
    } catch (error) {
      if (!current()) return;
      await this.disconnect(server).catch(() => undefined);
      if (!wanted()) return;
      this.errors.set(server.name, error instanceof Error ? error.message : String(error));
      ctx.ui.notify(`MCP ${server.name}: ${this.errors.get(server.name)}`, "error");
    } finally {
      if (current()) {
        this.connecting.delete(server.name);
        this.changed();
      }
    }
  }

  private async disconnect(server: ResolvedMcpServer): Promise<void> {
    const session = this.sessions.get(server.name);
    this.closeListeners.get(server.name)?.();
    this.closeListeners.delete(server.name);
    this.sessions.delete(server.name);
    this.errors.delete(server.name);
    this.deactivateTools(server.name);
    this.changed();
    if (session) await session.close();
  }

  private registerTools(serverName: string, session: ConnectedMcpServer): void {
    const names = new Set<string>();
    this.registered.set(serverName, names);
    for (const tool of session.tools) {
      const name = mcpToolName(serverName, tool.name);
      if (
        names.has(name) ||
        [...this.registered].some(([owner, tools]) => owner !== serverName && tools.has(name))
      ) {
        throw new Error(`MCP tool name collision: ${name}`);
      }
      names.add(name);
      const snippet = mcpPromptSnippet(tool.description, `${serverName} ${tool.name}`);
      this.pi.registerTool({
        name,
        label: `${serverName} ${tool.name}`,
        description: `${tool.description}\nText output is limited to 2000 lines or 50 KiB; larger results are saved to a private temporary file.`,
        promptSnippet: snippet,
        parameters: tool.inputSchema,
        executionMode: "sequential",
        execute: async (_toolCallId, params, signal) => {
          const live = this.sessions.get(serverName);
          if (!live) throw new Error(`MCP server ${serverName} is disconnected.`);
          const result = await live.call(tool.name, params, signal);
          const output = await limitMcpOutput(result.text);
          if (result.isError) throw new Error(output.text);
          return {
            content: [{ type: "text", text: output.text }, ...(result.images ?? [])],
            details: {
              server: serverName,
              tool: tool.name,
              ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
            },
          };
        },
        renderCall: (_args, theme) =>
          new Text(theme.fg("toolTitle", theme.bold(`${serverName} ${tool.name}`)), 0, 0),
        // Pi supplies the native collapsed/expanded result renderer and image display.
      });
    }
    this.lastTools.set(
      serverName,
      session.tools.map((tool) => summarizeTool(tool)),
    );
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

function summarizeTool(tool: {
  name: string;
  description: string;
  inputSchema?: unknown;
}): McpToolSummary {
  const summary: McpToolSummary = { name: tool.name, description: tool.description };
  if (tool.inputSchema !== undefined) summary.inputSchema = tool.inputSchema;
  return summary;
}
