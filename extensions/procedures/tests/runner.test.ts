import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentExecutor, ProcedureDefinition, ProcedureRun } from "../models.ts";
import { emptyUsage } from "../models.ts";
import { ProcedureRegistry } from "../runner.ts";
import { ProcedureRunStore } from "../store.ts";

async function waitForTerminal(registry: ProcedureRegistry, id: string): Promise<ProcedureRun> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), 5_000);
    const check = () => {
      const run = registry.get(id);
      if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise(run);
      }
    };
    const unsubscribe = registry.subscribe(check);
    check();
  });
}

function definition(tools: ProcedureDefinition["allowedTools"] = ["read"]): ProcedureDefinition {
  return {
    version: 1,
    name: "test",
    title: "Test procedure",
    description: "test",
    goal: "test",
    sourceFile: "test.proc.js",
    allowedTools: tools,
    createdAt: new Date().toISOString(),
  };
}

test("worker orchestrates parallel agents and records visibility state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-runner-"));
  const executor: AgentExecutor = {
    async execute(request, options) {
      options.onUpdate({
        activity: "reading source",
        tool: {
          toolCallId: `tool-${request.taskId}`,
          name: "read",
          summary: "src/index.ts",
          status: "completed",
        },
      });
      assert.equal(request.model, "test/fast");
      assert.equal(request.thinkingLevel, "low");
      return {
        text: `result:${request.taskId}`,
        usage: { ...emptyUsage(), input: 10, output: 5, turns: 1 },
        model: "test/fast",
        thinkingLevel: "low",
      };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(),
    source:
      'const options = { tools: ["read"], model: "test/fast", thinking: "low" }; const results = await Promise.all([$.agent("a", "one", options), $.agent("b", "two", options)]); return results.map((r) => r.text);',
    sourcePath: join(directory, "test.proc.js"),
    input: { goal: "test" },
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "completed");
  assert.deepEqual(terminal.result, ["result:a", "result:b"]);
  assert.equal(terminal.tasks.length, 2);
  assert.equal(terminal.tasks[0]?.recentTools[0]?.tool, "read");
  assert.equal(terminal.tasks[0]?.model, "test/fast");
  assert.equal(terminal.tasks[0]?.thinkingLevel, "low");
  assert.equal(terminal.usage.input, 20);
});

test("pause and resume keep background scheduling user-controlled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-controls-"));
  let calls = 0;
  const executor: AgentExecutor = {
    async execute() {
      calls += 1;
      return { text: "done", usage: emptyUsage() };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(),
    source:
      'await $.phase("delay"); await $.sleep(100); return await $.agent("after-pause", "continue", { tools: ["read"] });',
    sourcePath: join(directory, "test.proc.js"),
    input: {},
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for delay phase")), 5_000);
    const check = () => {
      if (registry.get(run.id)?.phase === "delay") {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise();
      }
    };
    const unsubscribe = registry.subscribe(check);
    check();
  });
  assert.ok(registry.pause(run.id));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  assert.equal(calls, 0);
  assert.equal(registry.get(run.id)?.status, "paused");
  assert.ok(registry.resume(run.id));
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "completed");
  assert.equal(calls, 1);
});

test("a procedure cannot finish while a host operation is unawaited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-runner-"));
  const executor: AgentExecutor = {
    async execute() {
      return { text: "unused", usage: emptyUsage() };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(),
    source: '$.sleep(20); return "too early";',
    sourcePath: join(directory, "test.proc.js"),
    input: {},
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /unawaited host operation/);
});

test("isolated source cannot reach the worker process through API constructors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-runner-"));
  const executor: AgentExecutor = {
    async execute() {
      return { text: "unused", usage: emptyUsage() };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(),
    source: 'return $.agent.constructor("return process")();',
    sourcePath: join(directory, "test.proc.js"),
    input: { goal: "test" },
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /Code generation from strings disallowed|not a function/);
});

test("stopping a waiting run clears pending approval state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-stop-approval-"));
  const executor: AgentExecutor = {
    async execute() {
      return { text: "unused", usage: emptyUsage() };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(),
    source: 'const ok = await $.approval("Ship it?"); return ok;',
    sourcePath: join(directory, "test.proc.js"),
    input: {},
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for approval")), 5_000);
    const check = () => {
      const current = registry.get(run.id);
      if (current?.pendingApproval) {
        clearTimeout(timer);
        unsubscribe();
        resolvePromise();
      }
    };
    const unsubscribe = registry.subscribe(check);
    check();
  });
  assert.equal(registry.get(run.id)?.status, "waiting");
  assert.ok(registry.stop(run.id));
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.pendingApproval, undefined);
});

test("undeclared tools fail before agent execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-procedure-runner-"));
  let called = false;
  const executor: AgentExecutor = {
    async execute() {
      called = true;
      return { text: "unexpected", usage: emptyUsage() };
    },
  };
  const registry = new ProcedureRegistry({ store: new ProcedureRunStore(directory, directory) });
  const run = registry.start({
    definition: definition(["read"]),
    source: 'return await $.agent("writer", "change it", { tools: ["write"] });',
    sourcePath: join(directory, "test.proc.js"),
    input: {},
    cwd: directory,
    model: "test/model",
    thinkingLevel: "off",
    executor,
  });
  const terminal = await waitForTerminal(registry, run.id);
  assert.equal(terminal.status, "failed");
  assert.match(terminal.error ?? "", /undeclared tool write/);
  assert.equal(called, false);
});
