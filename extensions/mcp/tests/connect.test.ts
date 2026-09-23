import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  describeMcpTool,
  isPermanentMcpError,
  isTransientMcpError,
  McpHttpStatusError,
  McpTimeoutError,
  mcpPromptSnippet,
  toMcpToolResult,
  withTimeout,
} from "../connect.ts";

test("formats MCP tool results as plain text", () => {
  assert.deepEqual(
    toMcpToolResult({
      content: [{ type: "text", text: "2" }],
    }),
    { text: "2", isError: false },
  );
  assert.equal(
    toMcpToolResult({
      content: [{ type: "text", text: "failed" }],
      isError: true,
    }).isError,
    true,
  );
  assert.equal(toMcpToolResult({ structuredContent: { ok: true } }).text, '{"ok":true}');
  assert.equal(toMcpToolResult({}).text, "(empty MCP result)");
});

test("keeps MCP descriptions and compact prompt snippets", () => {
  const description = "Execute TypeScript in a sandboxed runtime.\n\nMore detail.";
  assert.equal(describeMcpTool(description, "executor", "execute"), description);
  assert.equal(
    mcpPromptSnippet(description, "fallback"),
    "Execute TypeScript in a sandboxed runtime.",
  );
  assert.equal(describeMcpTool(undefined, "executor", "skills"), "executor skills");
});

test("retries transient HTTP and network errors, not authentication or cancellation", () => {
  for (const status of [408, 429, 500, 502, 503, 504])
    assert.equal(isTransientMcpError(new StreamableHTTPError(status, "temporary")), true);
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isTransientMcpError(new StreamableHTTPError(status, "permanent")), false);
    assert.equal(isPermanentMcpError(new StreamableHTTPError(status, "permanent")), true);
  }
  assert.equal(isTransientMcpError(new TypeError("fetch failed")), false);
  assert.equal(
    isTransientMcpError(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      }),
    ),
    true,
  );
  assert.equal(
    isTransientMcpError(
      Object.assign(new TypeError("Unable to connect"), { code: "ConnectionRefused" }),
    ),
    true,
  );
  assert.equal(isTransientMcpError(new McpTimeoutError("Timed out connecting to executor")), true);
  assert.equal(
    isTransientMcpError(new McpTimeoutError("Timed out listing tools for executor")),
    true,
  );
  assert.equal(isTransientMcpError(new Error("Timed out listing tools for executor")), false);
  assert.equal(isTransientMcpError(new McpHttpStatusError(503)), true);
  assert.equal(isPermanentMcpError(new McpHttpStatusError(401)), true);
  assert.equal(isTransientMcpError(new Error("invalid credentials")), false);
  assert.equal(isTransientMcpError(new DOMException("cancelled", "AbortError")), false);
});

test("tool-discovery timeout retains a retryable error type", async () => {
  const keepAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      withTimeout(new Promise<never>(() => {}), 10, new McpTimeoutError("Timed out listing tools")),
      (error: unknown) => error instanceof McpTimeoutError && isTransientMcpError(error),
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("timeout does not leave an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  const keepAlive = setTimeout(() => undefined, 200);
  let rejectLater!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, reject) => {
    rejectLater = reject;
  });
  try {
    await assert.rejects(() => withTimeout(pending, 20, "timed out"), /timed out/);
    rejectLater(new Error("closed after timeout"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rejections.length, 0);
  } finally {
    clearTimeout(keepAlive);
    process.off("unhandledRejection", onUnhandled);
  }
});
