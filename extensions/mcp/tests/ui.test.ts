import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMcpSettingItems, formatStatusText, serverDescription } from "../ui.ts";
import type { McpServerStatus } from "../manager.ts";

const executor: McpServerStatus = {
  name: "executor",
  enabled: true,
  status: "connected",
  tools: [
    { name: "execute", description: "Run TypeScript" },
    { name: "resume", description: "Resume a paused run" },
  ],
  source: "/tmp/mcp.json",
  type: "http",
};

test("builds a settings row per MCP server", () => {
  const items = buildMcpSettingItems([
    executor,
    { ...executor, name: "files", enabled: false, status: "disconnected", tools: [] },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.id, "executor");
  assert.equal(items[0]?.currentValue, "enabled");
  assert.equal(items[0]?.description, "connected · 2 tools");
  assert.equal(items[1]?.currentValue, "disabled");
  assert.deepEqual(items[0]?.values, ["enabled", "disabled"]);
});

test("summarizes failed servers with the connection error", () => {
  assert.equal(
    serverDescription({ ...executor, status: "failed", error: "fetch failed" }),
    "failed · fetch failed",
  );
  assert.equal(formatStatusText([]), "No MCP servers configured.");
  assert.match(formatStatusText([executor]), /executor: enabled \(connected\)/);
});
