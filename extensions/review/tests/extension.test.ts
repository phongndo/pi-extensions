import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import reviewExtension from "../index.ts";

test("registers both review workflows without adding a main-agent tool", () => {
  const commands: string[] = [];
  const tools: string[] = [];
  const pi = {
    getActiveTools() {
      throw new Error("action method called during extension loading");
    },
    on() {},
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer() {},
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    setActiveTools() {
      throw new Error("action method called during extension loading");
    },
  } as unknown as ExtensionAPI;

  reviewExtension(pi);

  assert.deepEqual(commands, ["review", "end-review", "settings-review", "loop-review"]);
  assert.deepEqual(tools, []);
});
