import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import mcpExtension from "../index.ts";

test("registers a single /mcp command", () => {
  const commands = new Map<string, { description: string }>();
  const pi = {
    registerCommand(name: string, options: { description: string }) {
      commands.set(name, options);
    },
    on() {},
  } as unknown as ExtensionAPI;
  mcpExtension(pi);
  assert.equal(commands.size, 1);
  assert.equal(commands.get("mcp")?.description, "Enable or disable MCP servers");
});
