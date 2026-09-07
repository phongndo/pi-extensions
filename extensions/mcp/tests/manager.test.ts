import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  ToolExecutionComponent,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpConfigPaths, ResolvedMcpServer } from "../config.ts";
import type { ConnectedMcpServer } from "../connect.ts";
import { McpManager } from "../manager.ts";

const tempRoots: string[] = [];
after(() => Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixturePaths(): Promise<McpConfigPaths> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-manager-"));
  tempRoots.push(root);
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
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const notifications: string[] = [];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/",
    isProjectTrusted: () => false,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    tools,
    notifications,
    getActive: () => active,
    manager: new McpManager(pi, connect),
  };
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

test("start applies an in-flight disable to reloaded config objects", async () => {
  const paths = await fixturePaths();
  const { ctx, getActive, manager } = harness(async (server) => fakeSession(server.name, () => {}));
  await manager.start(ctx, paths);
  assert.ok(getActive().includes("mcp__executor__execute"));
  const disabled = manager.setEnabled("executor", false, ctx);
  await manager.start(ctx, paths);
  await disabled;
  assert.equal(manager.snapshot()[0]?.enabled, false);
  assert.equal(getActive().includes("mcp__executor__execute"), false);
});

test("a completed toggle does not override a later overlay on start", async () => {
  const paths = await fixturePaths();
  const { ctx, getActive, manager } = harness(async (server) => fakeSession(server.name, () => {}));
  await manager.start(ctx, paths);
  await manager.setEnabled("executor", false, ctx);
  assert.equal(getActive().includes("mcp__executor__execute"), false);
  await writeFile(
    paths.agentOverlay,
    JSON.stringify({ mcpServers: { executor: { disabled: false } } }),
  );
  await manager.start(ctx, paths);
  assert.equal(manager.snapshot()[0]?.enabled, true);
  assert.ok(getActive().includes("mcp__executor__execute"));
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

test("uses Pi's native collapsed result renderer and refreshes schemas on reconnect", async () => {
  const paths = await fixturePaths();
  let version = 0;
  const app = harness(async (server) => {
    const session = fakeSession(server.name, () => {});
    session.tools[0]!.description = `Version ${++version}`;
    session.tools[0]!.inputSchema = Type.Object({ version: Type.Literal(version) });
    return session;
  });
  try {
    await app.manager.start(app.ctx, paths);
    const first = app.tools.get("mcp__executor__execute")!;
    assert.equal(first.renderResult, undefined, "let Pi own collapse/expand and output styling");
    initTheme("dark", false);
    const row = new ToolExecutionComponent(
      first.name,
      "call",
      {},
      {},
      first,
      { requestRender() {} } as ConstructorParameters<typeof ToolExecutionComponent>[5],
      "/tmp",
    );
    row.updateResult(
      {
        content: [
          { type: "text", text: Array.from({ length: 15 }, (_, i) => `line-${i}`).join("\n") },
        ],
        isError: false,
      },
      false,
    );
    assert.match(row.render(80).join("\n"), /more lines/);
    assert.doesNotMatch(row.render(80).join("\n"), /line-14/);
    row.setExpanded(true);
    assert.match(row.render(80).join("\n"), /line-14/);
    await app.manager.setEnabled("executor", false, app.ctx);
    await app.manager.setEnabled("executor", true, app.ctx);
    const next = app.tools.get("mcp__executor__execute")!;
    assert.notEqual(next, first);
    assert.match(next.description, /Version 2/);
  } finally {
    await app.manager.stop();
  }
});

test("registered tools preserve images, bound text, forward cancellation, and signal errors", async (t) => {
  const paths = await fixturePaths();
  const controller = new AbortController();
  const text = "x".repeat(60_000);
  let fail = false;
  const app = harness(async (server) => {
    const session = fakeSession(server.name, () => {});
    session.call = async (_name, _args, signal) => {
      assert.equal(signal, controller.signal);
      return fail
        ? { text: "tool failed", isError: true }
        : {
            text,
            isError: false,
            images: [{ type: "image", mimeType: "image/png", data: "pixel" }],
          };
    };
    return session;
  });
  t.after(() => app.manager.stop());
  await app.manager.start(app.ctx, paths);
  const tool = app.tools.get("mcp__executor__execute")!;
  const result = await tool.execute("call", {}, controller.signal, undefined, app.ctx);
  assert.equal(result.content[1]?.type, "image");
  const first = result.content[0]!;
  assert.ok(first.type === "text" && first.text.length < 52_000);
  const outputPath = (result.details as { fullOutputPath: string }).fullOutputPath;
  t.after(() => rm(dirname(outputPath), { recursive: true, force: true }));
  assert.equal(await readFile(outputPath, "utf8"), text);
  fail = true;
  await assert.rejects(
    tool.execute("call", {}, controller.signal, undefined, app.ctx),
    /tool failed/,
  );
});

test("closed transports remove active tools and publish the new connection state", async () => {
  const paths = await fixturePaths();
  let closed: (() => void) | undefined;
  const app = harness(async (server) =>
    Object.assign(
      fakeSession(server.name, () => {}),
      {
        onClose(listener: () => void) {
          closed = listener;
          return () => {
            closed = undefined;
          };
        },
      },
    ),
  );
  const states: string[] = [];
  const unsubscribe = app.manager.subscribe(() =>
    states.push(app.manager.snapshot()[0]?.status ?? "none"),
  );
  try {
    await app.manager.start(app.ctx, paths);
    assert.ok(closed, "manager must observe transport closure");
    assert.equal(app.manager.snapshot()[0]?.status, "connected");
    closed();
    assert.equal(app.manager.snapshot()[0]?.status, "disconnected");
    assert.deepEqual(app.getActive(), ["read", "bash"]);
    assert.deepEqual(states.slice(-1), ["disconnected"]);
  } finally {
    unsubscribe();
    await app.manager.stop();
  }
});

test("late connection failures after shutdown cannot notify or revive state", async () => {
  const paths = await fixturePaths();
  let reject!: (error: Error) => void;
  let began!: () => void;
  const connecting = new Promise<void>((resolve) => {
    began = resolve;
  });
  const app = harness(() => {
    began();
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  });
  const started = app.manager.start(app.ctx, paths);
  await connecting;
  await app.manager.stop();
  reject(new Error("late failure"));
  await started;
  assert.deepEqual(app.notifications, []);
  assert.ok(app.manager.snapshot().every((server) => server.status !== "failed"));
  assert.deepEqual(app.getActive(), ["read", "bash"]);
});

test("shutdown while restart is closing old clients cancels that restart", async () => {
  const paths = await fixturePaths();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let connections = 0;
  const app = harness(async (server) => {
    connections++;
    const session = fakeSession(server.name, () => {});
    session.close = () => gate;
    return session;
  });
  await app.manager.start(app.ctx, paths);
  const restarted = app.manager.start(app.ctx, paths);
  await app.manager.stop();
  release();
  await restarted;
  assert.equal(connections, 1);
  assert.deepEqual(app.getActive(), ["read", "bash"]);
});
