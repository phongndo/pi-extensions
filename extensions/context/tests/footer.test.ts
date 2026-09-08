import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFooterStatus } from "../../../src/footer-status.ts";

function fixture() {
  const statuses = new Map<string, string>();
  const ctx = {
    hasUI: true,
    sessionManager: {},
    ui: {
      setStatus(key: string, value?: string) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    statuses,
    line: () =>
      [...statuses]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text)
        .join(" "),
  };
}

for (const order of [
  ["context", "fast-mode", "mcp"],
  ["mcp", "fast-mode", "context"],
  ["fast-mode", "context", "mcp"],
])
  test(`native footer separators follow display order: ${order.join(", ")}`, () => {
    const app = fixture();
    const labels: Record<string, string> = {
      context: "ctxt recall",
      "fast-mode": "fast",
      mcp: "mcp 1/2",
    };
    for (const key of order) setFooterStatus({ ...app.ctx }, key, labels[key]);
    assert.equal(app.line(), "ctxt recall · fast · mcp 1/2");
    setFooterStatus(app.ctx, "fast-mode", undefined);
    assert.equal(app.line(), "ctxt recall · mcp 1/2");
    setFooterStatus(app.ctx, "context", "ctxt normal");
    assert.equal(app.line(), "ctxt normal · mcp 1/2");
    setFooterStatus(app.ctx, "context", undefined);
    assert.equal(app.line(), "mcp 1/2");
    setFooterStatus(app.ctx, "mcp", undefined);
    assert.equal(app.line(), "");
    setFooterStatus(app.ctx, "fast-mode", "fast");
    assert.equal(app.line(), "fast");
    setFooterStatus(app.ctx, "fast-mode", undefined);
  });

test("a failing sibling publisher does not evict a healthy footer status", () => {
  const app = fixture();
  let fail = false;
  const sibling = {
    ...app.ctx,
    ui: {
      setStatus(key: string, value?: string) {
        if (fail) throw new Error("stale UI");
        app.ctx.ui.setStatus(key, value);
      },
    },
  } as ExtensionContext;
  setFooterStatus(sibling, "mcp", "mcp 1/1");
  fail = true;
  assert.throws(() => setFooterStatus(app.ctx, "context", "ctxt recall"), /stale UI/);
  assert.doesNotThrow(() => setFooterStatus(app.ctx, "fast-mode", "fast"));
  assert.equal(app.statuses.get("context"), "ctxt recall");
  assert.equal(app.statuses.get("fast-mode"), "· fast");
});

test("failed status removal still refreshes sibling separators", () => {
  const app = fixture();
  setFooterStatus(app.ctx, "context", "ctxt recall");
  setFooterStatus(app.ctx, "mcp", "mcp 1/1");
  const stale = {
    ...app.ctx,
    ui: {
      setStatus() {
        throw new Error("stale UI");
      },
    },
  } as unknown as ExtensionContext;
  assert.throws(() => setFooterStatus(stale, "context", undefined), /stale UI/);
  assert.equal(app.statuses.get("mcp"), "mcp 1/1");
});

test("footer separator state is session-local and leaves other statuses alone", () => {
  const first = fixture();
  const second = fixture();
  first.statuses.set("other", "untouched");
  setFooterStatus(first.ctx, "context", "ctxt recall");
  setFooterStatus(second.ctx, "mcp", "mcp 1/1");
  assert.equal(second.line(), "mcp 1/1");
  assert.equal(first.statuses.get("other"), "untouched");
  setFooterStatus(first.ctx, "context", undefined);
  setFooterStatus(second.ctx, "mcp", undefined);
});
