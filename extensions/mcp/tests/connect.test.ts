import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMcpTool, mcpPromptSnippet, toMcpToolResult, withTimeout } from "../connect.ts";

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
