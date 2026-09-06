import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpConfigPaths, ResolvedMcpServer } from "../config.ts";
import type { ConnectedMcpServer } from "../connect.ts";
import { McpManager } from "../manager.ts";

async function fixturePaths(): Promise<McpConfigPaths> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-manager-"));
  const project = join(root, "project");
  await mkdir(join(root, "mcp"), { recursive: true });
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  const paths: McpConfigPaths = {
    sharedConfig: join(root, "mcp", "mcp.json"),
    agentOverlay: join(root, "agent", "mcp.json"),
    projectMcpJson: join(project, ".mcp.json"),
    projectPiMcpJson: join(project, ".pi", "mcp.json"),
  };
  await writeFile(
    paths.sharedConfig,
    JSON.stringify({
      mcpServers: {
        executor: { url: "http://localhost:4789/mcp" },
      },
    }),
  );
  return paths;
}

function fakeSession(name: string, onClose: () => void): ConnectedMcpServer {
  return {
    name,
    tools: [
      {
        name: "execute",
        description: "Run code",
        inputSchema: Type.Object({}),
      },
    ],
    async call() {
      return { text: "2", isError: false };
    },
    async close() {
      onClose();
    },
  };
}

function harness(connect: (server: ResolvedMcpServer) => Promise<ConnectedMcpServer>) {
  let active = ["read", "bash"];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerTool() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/",
    isProjectTrusted: () => false,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  return { pi, ctx, getActive: () => active, manager: new McpManager(pi, connect) };
}

test("stop removes MCP tools from the active set", async () => {
  const paths = await fixturePaths();
  const { ctx, getActive, manager } = harness(async (server) => fakeSession(server.name, () => {}));
  await manager.start(ctx, paths);
  assert.ok(getActive().includes("mcp__executor__execute"));
  await manager.stop();
  assert.equal(getActive().includes("mcp__executor__execute"), false);
  assert.deepEqual(getActive(), ["read", "bash"]);
});

test("a connect that finishes after disable does not revive the server", async () => {
  const paths = await fixturePaths();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closed: string[] = [];
  const { ctx, getActive, manager } = harness(async (server) => {
    await gate;
    return fakeSession(server.name, () => {
      closed.push(server.name);
    });
  });

  const started = manager.start(ctx, paths);
  for (let attempt = 0; attempt < 50 && manager.snapshot().length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(manager.snapshot()[0]?.name, "executor");
  const disabled = manager.setEnabled("executor", false, ctx);
  release();
  await started;
  await disabled;

  assert.equal(manager.snapshot()[0]?.enabled, false);
  assert.equal(manager.snapshot()[0]?.status, "disconnected");
  assert.equal(getActive().includes("mcp__executor__execute"), false);
  assert.ok(closed.includes("executor"));
});
