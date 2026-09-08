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

function fixture(mode: ExtensionContext["mode"] = "tui") {
  const statuses = new Map<string, string>([
    ["other", "other extension"],
    ["fast-mode", "fast"],
  ]);
  const listeners = new Set<() => void>();
  let updates = 0;
  let servers = [{ enabled: true, status: "connected" }] as McpServerStatus[];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      setStatus(key: string, value?: string) {
        updates++;
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setFooter() {
        throw new Error("Must not replace custom footers");
      },
    },
  } as unknown as ExtensionContext;
  const manager = {
    snapshot: () => servers,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as McpManager;
  return {
    ctx,
    manager,
    statuses,
    listeners,
    get updates() {
      return updates;
    },
    change(status?: "connected" | "disconnected") {
      servers = status ? ([{ enabled: true, status }] as McpServerStatus[]) : [];
      for (const listener of listeners) listener();
    },
  };
}

test("MCP label counts connected / configured, including disabled and failed servers", () => {
  assert.equal(formatMcpCount([]), undefined);
  assert.equal(
    formatMcpCount([
      { enabled: true, status: "connected" },
      { enabled: true, status: "failed" },
      { enabled: false, status: "disconnected" },
    ]),
    "mcp 1/3",
  );
  assert.equal(formatMcpCount([{ enabled: false, status: "connected" }]), "mcp 0/1");
});

for (const mode of ["tui", "rpc", "print", "json"] as const)
  test(`${mode}: native status updates and cleanup preserve other extensions`, () => {
    const app = fixture(mode);
    const original = FooterComponent.prototype.render;
    const remove = installMcpStatus(app.ctx, app.manager);
    try {
      if (app.ctx.hasUI) {
        assert.equal(app.statuses.get("mcp"), "mcp 1/1");
        const before = app.updates;
        app.change("connected");
        assert.equal(app.updates, before, "unchanged labels do not redraw");
        app.change("disconnected");
        assert.equal(app.statuses.get("mcp"), "mcp 0/1");
        app.change();
        assert.equal(app.statuses.has("mcp"), false);
      } else {
        assert.equal(app.updates, 0);
        assert.equal(app.listeners.size, 0);
      }
      assert.equal(FooterComponent.prototype.render, original);
    } finally {
      remove();
      remove();
    }
    assert.deepEqual(
      [...app.statuses],
      [
        ["other", "other extension"],
        ["fast-mode", "fast"],
      ],
    );
    assert.equal(app.listeners.size, 0);
    const before = app.updates;
    app.change("connected");
    assert.equal(app.updates, before);
  });

test("Pi's footer API composes both minimal labels without touching the model line", () => {
  const app = fixture();
  const remove = installMcpStatus(app.ctx, app.manager);
  try {
    const footer = new FooterComponent(
      {
        state: {
          model: { id: "test-model", provider: "test", contextWindow: 100000 },
          thinkingLevel: "off",
        },
        sessionManager: SessionManager.inMemory(),
        getContextUsage: () => undefined,
        modelRuntime: { isUsingSubscription: () => false },
      } as unknown as ConstructorParameters<typeof FooterComponent>[0],
      {
        getGitBranch: () => null,
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => app.statuses,
      } as unknown as ConstructorParameters<typeof FooterComponent>[1],
    );
    for (const theme of ["dark", "light"]) {
      initTheme(theme, false);
      for (const width of [16, 40, 80, 160]) {
        const lines = footer.render(width);
        assert.doesNotMatch(stripVTControlCharacters(lines[1]!), /mcp|fast/);
        if (width >= 80) assert.match(stripVTControlCharacters(lines[2]!), /fast.*mcp 1\/1/);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
      }
    }
  } finally {
    remove();
  }
});

test("failed UI setup removes its subscription", () => {
  const app = fixture();
  app.ctx.ui.setStatus = () => {
    throw new Error("UI unavailable");
  };
  assert.throws(() => installMcpStatus(app.ctx, app.manager), /UI unavailable/);
  assert.equal(app.listeners.size, 0);
});
