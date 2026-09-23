import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Type, type TSchema } from "typebox";
import type { ResolvedMcpServer } from "./config.ts";
import { wrapToolSchema } from "./config.ts";

export const CONNECT_TIMEOUT_MS = 10_000;
export const LIST_TOOLS_TIMEOUT_MS = 8_000;
const CLIENT_NAME = "pi-mcp";
const CLIENT_VERSION = "0.1.0";

export class McpTimeoutError extends Error {}

// SSEClientTransport turns a failing POST into a plain Error, dropping its
// status code. Preserve it at the HTTP boundary for retry classification.
export class McpHttpStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`MCP HTTP request failed (${status})`);
    this.status = status;
  }
}

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
  onClose?(listener: (reason?: string) => void): () => void;
}

export function isPermanentMcpError(error: unknown): boolean {
  if (error instanceof McpHttpStatusError) {
    return [400, 401, 403, 404, 405, 422].includes(error.status);
  }
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return [400, 401, 403, 404, 405, 422].includes(error.code ?? 0);
  }
  return (
    error instanceof Error &&
    ["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
  );
}

export function isTransientMcpError(error: unknown): boolean {
  if (error instanceof McpTimeoutError) return true;
  if (error instanceof McpHttpStatusError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  if (error instanceof StreamableHTTPError || error instanceof SseError) {
    return [408, 429, 500, 502, 503, 504].includes(error.code ?? 0);
  }
  return error instanceof TypeError && hasNetworkCode(error);
}

function hasNetworkCode(error: Error): boolean {
  if (
    [
      "ConnectionRefused",
      "ConnectionReset",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EHOSTUNREACH",
    ].includes((error as NodeJS.ErrnoException).code ?? "")
  )
    return true;
  if (error.cause instanceof Error) return hasNetworkCode(error.cause);
  if (error instanceof AggregateError)
    return error.errors.some((item: unknown) => item instanceof Error && hasNetworkCode(item));
  return false;
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
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  let closed = false;
  let closing: Promise<void> | undefined;
  const awaitingStreamResponse = new Map<
    string | number,
    ReturnType<typeof setTimeout> | undefined
  >();
  let getFailures = 0;
  let receivedGetStream = false;
  let transport: ReturnType<typeof createTransport>;
  const listeners = new Set<(reason?: string) => void>();
  let closeReason: string | undefined;
  client.onclose = () => {
    if (closed) return;
    closed = true;
    for (const timer of awaitingStreamResponse.values()) if (timer) clearTimeout(timer);
    awaitingStreamResponse.clear();
    for (const listener of listeners) listener(closeReason);
    listeners.clear();
  };
  const close = () =>
    (closing ??= Promise.allSettled([client.close(), transport.close()]).then(() => undefined));
  const failedGet = () => {
    if (closed) return;
    if (++getFailures >= (receivedGetStream ? 2 : 1)) {
      closeReason = "HTTP notification stream lost";
      void close();
    }
  };
  const httpFetch: typeof fetch = async (input, init) => {
    if (closed) throw new Error("MCP transport closed");
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      // The SDK does not close after failed notification-stream GET retries.
      // Track a network failure here, then preserve the original fetch error.
      if (init?.method === "GET") failedGet();
      throw error;
    }
    if (init?.method === "GET") {
      if (response.ok) {
        receivedGetStream = true;
        getFailures = 0;
      } else if (response.status !== 405) failedGet(); // POST-only servers need no GET stream.
    }
    if (
      init?.method === "POST" &&
      response.ok &&
      response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") &&
      response.body
    ) {
      // The SDK resolves tools/call only after parsing the JSON-RPC response.
      // A POST stream may end before that response without rejecting the call.
      if (typeof init.body !== "string") throw new Error("Unexpected MCP POST body");
      const request: unknown = JSON.parse(init.body);
      if (!isRecord(request)) throw new Error("Unexpected MCP POST message");
      if (request.method !== "tools/call") return response;
      const id = request.id;
      if (typeof id !== "string" && typeof id !== "number") {
        throw new Error("MCP tool request is missing its JSON-RPC id");
      }
      awaitingStreamResponse.set(id, undefined);
      return watchResponseStream(response, () => {
        if (!awaitingStreamResponse.has(id)) return;
        // Give the SDK's stream parser time to deliver the final frame after EOF.
        const timer = setTimeout(() => {
          if (awaitingStreamResponse.has(id) && !closed) {
            closeReason = "HTTP tool response interrupted";
            void close(); // Reject the in-flight request; never replay it.
          }
        }, 150);
        awaitingStreamResponse.set(id, timer);
      });
    }
    return response;
  };
  transport = createTransport(server, httpFetch);
  transport.onmessage = (message) => {
    if (
      "id" in message &&
      (typeof message.id === "string" || typeof message.id === "number") &&
      ("result" in message || "error" in message)
    ) {
      const timer = awaitingStreamResponse.get(message.id);
      if (timer) clearTimeout(timer);
      awaitingStreamResponse.delete(message.id);
    }
  };
  const onAbort = () => {
    void close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await withTimeout(
      client.connect(transport as Transport),
      CONNECT_TIMEOUT_MS,
      new McpTimeoutError(`Timed out connecting to ${server.name}`),
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
      new McpTimeoutError(`Timed out listing tools for ${server.name}`),
    );
    signal?.throwIfAborted();
    if (closed) throw new Error(`MCP ${server.name} closed during initialization.`);
    return {
      name: server.name,
      tools,
      async call(toolName, args, signal) {
        try {
          const result = await client.callTool(
            { name: toolName, arguments: isRecord(args) ? args : {} },
            undefined,
            signal ? { signal } : undefined,
          );
          return toMcpToolResult(result);
        } catch (error) {
          if (
            transport instanceof StreamableHTTPClientTransport &&
            transport.sessionId &&
            error instanceof StreamableHTTPError &&
            error.code === 404
          ) {
            // A stateful server expired this session. Reinitialize on a fresh
            // connection; never replay a possibly side-effecting tool call.
            closeReason = "HTTP session expired";
            await close();
            throw new Error("MCP session expired; reconnecting. Tool call was not retried.", {
              cause: error,
            });
          }
          if (
            (transport instanceof StreamableHTTPClientTransport ||
              transport instanceof SSEClientTransport) &&
            error instanceof TypeError &&
            isTransientMcpError(error) &&
            !signal?.aborted
          ) {
            closeReason = "HTTP transport unavailable";
            await close();
          }
          // A request may have reached the server before the response failed.
          // Reconnect for the next call, but never automatically replay this one.
          throw error;
        }
      },
      close,
      onClose(listener) {
        if (closed) {
          listener(closeReason);
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

function createTransport(server: ResolvedMcpServer, httpFetch: typeof fetch) {
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
    return new SSEClientTransport(url, {
      ...(requestInit ? { requestInit } : {}),
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "POST" && !response.ok) {
          await response.body?.cancel();
          throw new McpHttpStatusError(response.status);
        }
        return response;
      },
    });
  }
  return new StreamableHTTPClientTransport(url, {
    ...(requestInit ? { requestInit } : {}),
    fetch: httpFetch,
  });
}

function watchResponseStream(response: Response, onEnd: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          onEnd();
        } else controller.enqueue(value);
      } catch (error) {
        // Propagate a broken response body to the SDK and retire its session.
        controller.error(error);
        onEnd();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string | Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(typeof message === "string" ? new Error(message) : message),
          ms,
        );
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
