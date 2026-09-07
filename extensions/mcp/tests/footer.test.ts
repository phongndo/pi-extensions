import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import {
  FooterComponent,
  SessionManager,
  initTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatMcpCount, installMcpStatus } from "../footer.ts";
import type { McpManager, McpServerStatus } from "../manager.ts";

// Exercise the real sibling extension without typechecking its entire workspace
// under MCP's different exactOptionalPropertyTypes setting.
const { installFastModeFooterPrefix } = (await import(
  new URL("../../fast-mode/footer.ts", import.meta.url).href
)) as {
  installFastModeFooterPrefix(
    owner: ExtensionContext["sessionManager"],
    readEnabled: () => boolean,
  ): () => void;
};

test("MCP count means connected / configured, including disabled and failed servers in total", () => {
  assert.equal(formatMcpCount([]), undefined);
  assert.equal(
    formatMcpCount([
      { enabled: true, status: "connected" },
      { enabled: true, status: "connecting" },
      { enabled: true, status: "failed" },
      { enabled: false, status: "disconnected" },
    ]),
    "mcp (1/4)",
  );
  assert.equal(formatMcpCount([{ enabled: false, status: "connected" }]), "mcp (0/1)");
});

function fixture(mode: ExtensionContext["mode"] = "tui") {
  const model = {
    id: "gpt-6-astra",
    provider: "openai-codex",
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 272000,
  } as NonNullable<ExtensionContext["model"]>;
  const owner = SessionManager.inMemory("/tmp/project");
  const statuses = new Map<string, string>([["other", "other extension"]]);
  let renders = 0;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: owner,
    model,
    ui: {
      setStatus(key: string, text?: string) {
        renders++;
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      setFooter() {
        throw new Error("Do not replace custom footers");
      },
    },
  } as unknown as ExtensionContext;
  let servers = [
    {
      name: "executor",
      enabled: true,
      status: "connected",
      tools: [],
      source: "fixture",
      type: "http",
    },
  ] as McpServerStatus[];
  const listeners = new Set<() => void>();
  const manager = {
    snapshot: () => servers,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as McpManager;
  const makeFooter = (sessionManager = owner) =>
    new FooterComponent(
      {
        state: { model, thinkingLevel: "xhigh" },
        sessionManager,
        getContextUsage: () => undefined,
        modelRuntime: { isUsingSubscription: () => true },
      } as unknown as ConstructorParameters<typeof FooterComponent>[0],
      {
        getGitBranch: () => "main",
        getAvailableProviderCount: () => 2,
        getExtensionStatuses: () => statuses,
      } as unknown as ConstructorParameters<typeof FooterComponent>[1],
    );
  return {
    ctx,
    manager,
    statuses,
    makeFooter,
    listeners,
    get renders() {
      return renders;
    },
    disconnect() {
      servers[0]!.status = "disconnected";
      for (const listener of listeners) listener();
    },
    clear() {
      servers = [];
      for (const listener of listeners) listener();
    },
  };
}

for (const mcpFirst of [false, true]) {
  for (const removeMcpFirst of [false, true]) {
    test(`inline MCP composes with Fast mode (load MCP first: ${mcpFirst}, remove MCP first: ${removeMcpFirst})`, () => {
      initTheme("dark", false);
      const app = fixture();
      const original = FooterComponent.prototype.render;
      const remove = new Map<string, () => void>();
      const installMcp = () => remove.set("mcp", installMcpStatus(app.ctx, app.manager));
      const installFast = () =>
        remove.set(
          "fast",
          installFastModeFooterPrefix(app.ctx.sessionManager, () => true),
        );
      const footer = app.makeFooter();
      if (mcpFirst) {
        installMcp();
        installFast();
      } else {
        installFast();
        installMcp();
      }
      try {
        for (const theme of ["dark", "light"]) {
          initTheme(theme, false);
          for (const width of [16, 40, 60, 100, 160]) {
            const lines = footer.render(width);
            const modelLine = stripVTControlCharacters(lines[1]!);
            assert.equal(
              lines.length,
              3,
              "preserve the existing other-extension row; add no new row",
            );
            if (width >= 100) {
              assert.match(modelLine, /\(auto\) mcp \(1\/1\) +\(openai-codex\) ϟ gpt-6-astra/);
              assert.equal(modelLine.match(/mcp \(/g)?.length, 1);
            }
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
          }
        }
        assert.doesNotMatch(app.makeFooter(SessionManager.inMemory()).render(160)[1]!, /mcp \(|ϟ/);
        const before = app.renders;
        app.disconnect();
        assert.ok(app.renders > before, "state changes request a redraw while idle");
        assert.match(footer.render(160)[1]!, /mcp \(0\/1\)/);
        assert.equal(app.statuses.has("mcp"), false);
        remove.get(removeMcpFirst ? "mcp" : "fast")!();
        const remaining = stripVTControlCharacters(footer.render(160)[1]!);
        if (removeMcpFirst) {
          assert.doesNotMatch(remaining, /mcp \(/);
          assert.match(remaining, /ϟ gpt/);
        } else {
          assert.match(remaining, /mcp \(0\/1\)/);
          assert.doesNotMatch(remaining, /ϟ/);
        }
      } finally {
        for (const cleanup of remove.values()) cleanup();
      }
      assert.equal(FooterComponent.prototype.render, original);
      assert.equal(app.listeners.size, 0);
      assert.deepEqual([...app.statuses], [["other", "other extension"]]);
      const before = app.renders;
      app.clear();
      assert.equal(app.renders, before, "disposed subscribers cannot revive status");
    });
  }
}

test("a failed UI installation leaves no footer decorator or subscription behind", () => {
  const app = fixture();
  const original = FooterComponent.prototype.render;
  app.ctx.ui.setStatus = () => {
    throw new Error("UI unavailable");
  };
  assert.throws(() => installMcpStatus(app.ctx, app.manager), /UI unavailable/);
  assert.equal(app.listeners.size, 0);
  assert.equal(FooterComponent.prototype.render, original);
});

test("RPC gets a native status and headless modes do not install UI or listeners", () => {
  for (const mode of ["rpc", "print", "json"] as const) {
    const app = fixture(mode);
    const original = FooterComponent.prototype.render;
    const remove = installMcpStatus(app.ctx, app.manager);
    try {
      if (mode === "rpc") {
        assert.equal(app.statuses.get("mcp"), "mcp (1/1)");
        app.disconnect();
        assert.equal(app.statuses.get("mcp"), "mcp (0/1)");
        app.clear();
        assert.equal(app.statuses.has("mcp"), false);
      } else {
        assert.equal(app.renders, 0);
        assert.equal(app.listeners.size, 0);
      }
      assert.equal(FooterComponent.prototype.render, original);
    } finally {
      remove();
    }
  }
});
