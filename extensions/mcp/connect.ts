import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type, type TSchema } from "typebox";
import type { ResolvedMcpServer } from "./config.ts";
import { wrapToolSchema } from "./config.ts";

export const CONNECT_TIMEOUT_MS = 10_000;
export const LIST_TOOLS_TIMEOUT_MS = 8_000;
const CLIENT_NAME = "pi-mcp";
const CLIENT_VERSION = "0.1.0";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: TSchema;
}

export interface ConnectedMcpServer {
  name: string;
  tools: McpToolDefinition[];
  call(
    toolName: string,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<McpToolCallResult>;
  close(): Promise<void>;
  onClose?(listener: () => void): () => void;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
  images?: { type: "image"; data: string; mimeType: string }[];
}

export function mcpParameters(inputSchema: unknown): TSchema {
  return Type.Unsafe(wrapToolSchema(inputSchema) as TSchema);
}

export function describeMcpTool(
  description: string | undefined,
  server: string,
  tool: string,
): string {
  const trimmed = description?.trim();
  return trimmed || `${server} ${tool}`;
}

export function mcpPromptSnippet(description: string, fallback: string): string {
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const text = firstLine || fallback;
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

export function toMcpToolResult(result: unknown): McpToolCallResult {
  const payload = isRecord(result) ? result : {};
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  const images: NonNullable<McpToolCallResult["images"]> = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      images.push({ type: "image", data: item.data, mimeType: item.mimeType });
      continue;
    }
    parts.push(JSON.stringify(item));
  }
  if (parts.length === 0 && payload.structuredContent !== undefined) {
    parts.push(JSON.stringify(payload.structuredContent));
  }
  return {
    text: parts.join("\n") || (images.length ? "(MCP image result)" : "(empty MCP result)"),
    isError: payload.isError === true,
    ...(images.length ? { images } : {}),
  };
}

export async function connectMcpServer(
  server: ResolvedMcpServer,
  signal?: AbortSignal,
): Promise<ConnectedMcpServer> {
  signal?.throwIfAborted();
  const transport = createTransport(server);
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  let closed = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  client.onclose = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const close = () =>
    (closing ??= Promise.allSettled([client.close(), transport.close()]).then(() => undefined));
  const onAbort = () => {
    void close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await withTimeout(
      client.connect(transport as Transport),
      CONNECT_TIMEOUT_MS,
      `Timed out connecting to ${server.name}`,
    );
    const tools = await withTimeout(
      (async () => {
        const tools: McpToolDefinition[] = [];
        if (!client.getServerCapabilities()?.tools) return tools;
        const seen = new Set<string>();
        let cursor: string | undefined;
        do {
          signal?.throwIfAborted();
          const listed = await client.listTools(cursor ? { cursor } : undefined);
          tools.push(
            ...listed.tools.map((tool) => ({
              name: tool.name,
              description: describeMcpTool(tool.description, server.name, tool.name),
              inputSchema: mcpParameters(tool.inputSchema),
            })),
          );
          cursor = listed.nextCursor;
          if (tools.length > 10_000 || seen.size >= 100 || (cursor && seen.has(cursor))) {
            throw new Error(`MCP ${server.name}: invalid or oversized tool catalog.`);
          }
          if (cursor) seen.add(cursor);
        } while (cursor);
        return tools;
      })(),
      LIST_TOOLS_TIMEOUT_MS,
      `Timed out listing tools for ${server.name}`,
    );
    signal?.throwIfAborted();
    if (closed) throw new Error(`MCP ${server.name} closed during initialization.`);
    return {
      name: server.name,
      tools,
      async call(toolName, args, signal) {
        const result = await client.callTool(
          { name: toolName, arguments: isRecord(args) ? args : {} },
          undefined,
          signal ? { signal } : undefined,
        );
        return toMcpToolResult(result);
      },
      close,
      onClose(listener) {
        if (closed) {
          listener();
          return () => {};
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function createTransport(server: ResolvedMcpServer) {
  if (server.type === "stdio") {
    if (!server.command) throw new Error(`MCP server ${server.name} is missing command.`);
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: "pipe",
      ...(server.cwd ? { cwd: server.cwd } : {}),
    });
    // Server logs must not write over Pi's TUI (or corrupt RPC/JSON output).
    transport.stderr?.on("data", () => {});
    return transport;
  }

  if (!server.url) throw new Error(`MCP server ${server.name} is missing url.`);
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.type === "sse") {
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
      }),
    ]);
  } catch (error) {
    void promise.then(
      () => undefined,
      () => undefined,
    );
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
