import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMcpSettingItems,
  estimateEnabledMcpTokens,
  estimateServerTokens,
  formatStatusText,
  formatTokenCount,
  serverDescription,
} from "../ui.ts";
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
  assert.match(items[0]?.description ?? "", /^connected · 2 tools · ~/);
  assert.match(items[0]?.description ?? "", /tokens/);
  assert.equal(items[1]?.currentValue, "disabled");
  assert.deepEqual(items[0]?.values, ["enabled", "disabled"]);
});

test("summarizes failed servers with the connection error", () => {
  assert.match(
    serverDescription({ ...executor, status: "failed", error: "fetch failed" }),
    /^failed · fetch failed · 2 tools · ~/,
  );
  assert.equal(formatStatusText([]), "No MCP servers configured.");
  assert.match(formatStatusText([executor]), /executor: enabled \(connected\)/);
  assert.match(formatStatusText([executor]), /tokens enabled/);
});

test("estimates MCP tool definition tokens", () => {
  assert.equal(formatTokenCount(12), "12");
  assert.equal(formatTokenCount(8400), "8.4k");
  assert.equal(formatTokenCount(12_100), "12k");
  const tokens = estimateServerTokens(executor);
  assert.ok(tokens > 0);
  assert.equal(
    estimateEnabledMcpTokens([executor, { ...executor, name: "other", enabled: false }]),
    tokens,
  );
});
