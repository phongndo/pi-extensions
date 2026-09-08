import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FooterComponent,
  SessionManager,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import mcpExtension, { createMcpExtension } from "../index.ts";

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

test("session lifecycle and /mcp menu update the native footer status", async (t) => {
  initTheme("dark", false);
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-ui-"));
  const paths = {
    sharedConfig: join(root, "shared.json"),
    agentOverlay: join(root, "overlay.json"),
    projectMcpJson: "unused",
    projectPiMcpJson: "unused",
  };
  await writeFile(
    paths.sharedConfig,
    JSON.stringify({
      mcpServers: {
        executor: { url: "http://unused.invalid/mcp" },
        backup: { url: "http://unused.invalid/mcp", disabled: true },
      },
    }),
  );
  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let active = ["read"];
  let connections = 0;
  let closes = 0;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, value: typeof command) {
      command = value;
    },
    registerTool() {},
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names;
    },
  } as unknown as ExtensionAPI;
  createMcpExtension({
    paths,
    connect: async (server) => {
      connections++;
      return {
        name: server.name,
        tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
        call: async () => ({ text: "ok", isError: false }),
        close: async () => {
          closes++;
        },
      };
    },
  })(pi);
  assert.equal(connections, 0, "factory must not open clients");
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  const model = {
    id: "gpt-6-astra",
    provider: "openai-codex",
    reasoning: true,
    contextWindow: 272000,
  };
  const sessionManager = SessionManager.inMemory(root);
  const footer = new FooterComponent(
    {
      state: { model, thinkingLevel: "xhigh" },
      sessionManager,
      getContextUsage: () => undefined,
      modelRuntime: { isUsingSubscription: () => false },
    } as unknown as ConstructorParameters<typeof FooterComponent>[0],
    {
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => statuses,
    } as unknown as ConstructorParameters<typeof FooterComponent>[1],
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: root,
    model,
    sessionManager,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus(key: string, value?: string) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter() {
        throw new Error("must not replace the footer");
      },
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const component = await factory(
          { requestRender() {} } as Parameters<typeof factory>[0],
          { fg: (_color: string, text: string) => text } as Parameters<typeof factory>[1],
          {} as Parameters<typeof factory>[2],
          () => {},
        );
        try {
          assert.match(component.render(100).join("\n"), /connected/);
          component.handleInput?.("\r");
          for (let i = 0; i < 100 && statuses.get("mcp") !== "mcp 0/2"; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.match(footer.render(160)[2]!, /mcp 0\/2/);
          assert.match(component.render(100).join("\n"), /disconnected/);
        } finally {
          component.dispose?.();
        }
      },
    },
  } as unknown as ExtensionCommandContext;
  const original = FooterComponent.prototype.render;
  t.after(async () => {
    await handlers.get("session_shutdown")!({}, ctx);
    await rm(root, { recursive: true, force: true });
  });
  await handlers.get("session_start")!({}, ctx);
  assert.equal(connections, 1);
  assert.match(footer.render(160)[2]!, /mcp 1\/2/);
  assert.equal(footer.render(160).length, 3);
  assert.equal(FooterComponent.prototype.render, original);
  await command.handler("", ctx);
  assert.deepEqual(active, ["read"]);
  assert.equal(
    JSON.parse(await readFile(paths.agentOverlay, "utf8")).mcpServers.executor.disabled,
    true,
  );
  assert.deepEqual(notifications, []);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(closes, 1);
  assert.equal(FooterComponent.prototype.render, original);
  await handlers.get("session_start")!({}, ctx);
  assert.equal(connections, 1, "disabled overlay persists across reload");
  assert.match(footer.render(160)[2]!, /mcp 0\/2/);
});
