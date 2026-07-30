import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { refreshVisibility } from "../index.ts";
import { emptyUsage, type ProcedureRun } from "../models.ts";
import type { ProcedureService } from "../command.ts";

function run(overrides: Partial<ProcedureRun> = {}): ProcedureRun {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "e6910d24-0000-0000-0000-000000000000",
    procedureName: "solid-todo",
    title: "Build a SolidJS todo app",
    description: "",
    goal: "Build it",
    allowedTools: ["read"],
    cwd: "/project",
    sourcePath: "/private/run.proc.js",
    status: "running",
    phase: "implementation",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "high",
    input: {},
    tasks: [],
    events: [],
    artifacts: [],
    usage: emptyUsage(),
    ...overrides,
  };
}

function harness(current: ProcedureRun[]): {
  ctx: ExtensionContext;
  service: ProcedureService;
  status: () => string | undefined;
  widget: () => unknown;
} {
  let status: string | undefined;
  let widget: unknown;
  const theme = { fg: (_color: string, text: string) => text };
  const ctx = {
    ui: {
      theme,
      setStatus: (_key: string, value: string | undefined) => {
        status = value;
      },
      setWidget: (_key: string, value: unknown) => {
        widget = value;
      },
    },
  } as unknown as ExtensionContext;
  const service = {
    registry: { list: () => current },
  } as unknown as ProcedureService;
  return { ctx, service, status: () => status, widget: () => widget };
}

test("ordinary background procedures use only compact footer status", () => {
  const state = harness([run()]);
  refreshVisibility(state.ctx, state.service);
  assert.equal(state.status(), "proc 1");
  assert.equal(state.widget(), undefined);
});

test("below-editor procedure UI appears only for actionable approval", () => {
  const state = harness([
    run({
      status: "waiting",
      pendingApproval: {
        requestId: "approval-1",
        label: "Apply the implementation?",
        requestedAt: new Date().toISOString(),
      },
    }),
  ]);
  refreshVisibility(state.ctx, state.service);
  assert.equal(state.status(), "proc 1 · 1 waiting");
  const factory = state.widget() as (
    tui: unknown,
    theme: { fg: (color: string, text: string) => string },
  ) => { render(width: number): string[] };
  assert.equal(typeof factory, "function");
  const lines = factory({}, { fg: (_color, text) => text }).render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /Apply the implementation\?/);
  assert.match(lines[0] ?? "", /\/monitor e6910d24/);
});
