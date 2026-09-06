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
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
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
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    parts.push(JSON.stringify(item));
  }
  if (parts.length === 0 && payload.structuredContent !== undefined) {
    parts.push(JSON.stringify(payload.structuredContent));
  }
  return {
    text: parts.join("\n") || "(empty MCP result)",
    isError: payload.isError === true,
  };
}

export async function connectMcpServer(server: ResolvedMcpServer): Promise<ConnectedMcpServer> {
  const transport = createTransport(server);
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  try {
    await withTimeout(
      client.connect(transport as Transport),
      CONNECT_TIMEOUT_MS,
      `Timed out connecting to ${server.name}`,
    );
    const listed = await withTimeout(
      client.listTools(),
      LIST_TOOLS_TIMEOUT_MS,
      `Timed out listing tools for ${server.name}`,
    );
    const tools = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: describeMcpTool(tool.description, server.name, tool.name),
      inputSchema: mcpParameters(tool.inputSchema),
    }));
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
      async close() {
        await Promise.allSettled([client.close(), transport.close()]);
      },
    };
  } catch (error) {
    await Promise.allSettled([client.close(), transport.close()]);
    throw error;
  }
}

function createTransport(server: ResolvedMcpServer) {
  if (server.type === "stdio") {
    if (!server.command) throw new Error(`MCP server ${server.name} is missing command.`);
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: { ...getDefaultEnvironment(), ...server.env },
      ...(server.cwd ? { cwd: server.cwd } : {}),
    });
  }

  if (!server.url) throw new Error(`MCP server ${server.name} is missing url.`);
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  if (server.type === "sse") {
    return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
