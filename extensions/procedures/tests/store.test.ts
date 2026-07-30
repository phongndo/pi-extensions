import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyUsage, type ProcedureRun } from "../models.ts";
import { ProcedureDefinitionStore, ProcedureRunStore } from "../store.ts";

test("ephemeral run source stays in the private run store", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-procedure-ephemeral-"));
  const store = new ProcedureRunStore(cwd, cwd);
  const source = 'return await $.agent("scan", "inspect", { tools: ["read"] });';
  const path = await store.writeSource(source);
  assert.match(path, /procedure-runs.*sources.*\.proc\.js$/);
  assert.match(await store.readSource(path), /\$\.agent/);
});

test("definition store writes reviewable source and allocates unique names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-procedure-store-"));
  const store = new ProcedureDefinitionStore(cwd);
  const authored = {
    name: "scan",
    title: "Scan",
    description: "Scan project",
    source: 'return await $.agent("scan", "inspect", { tools: ["read"] });',
    requiredTools: ["read" as const],
  };
  const first = await store.save(authored, "inspect");
  const second = await store.save(authored, "inspect again");
  assert.equal(first.name, "scan");
  assert.equal(second.name, "scan-2");
  assert.match((await store.source(first)).source, /\$\.agent/);
  assert.deepEqual((await store.load(first.name)).allowedTools, ["read", "grep", "find", "ls"]);
});

test("run store skips structurally corrupt snapshots", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-procedure-run-store-"));
  const store = new ProcedureRunStore(cwd, cwd);
  await mkdir(store.directory, { recursive: true });
  const valid: ProcedureRun = {
    version: 1,
    id: "valid-run",
    procedureName: "test",
    title: "Valid",
    description: "",
    goal: "test",
    allowedTools: ["read"],
    cwd,
    sourcePath: join(cwd, "test.proc.js"),
    status: "completed",
    phase: "completed",
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:01.000Z",
    model: "test/model",
    thinkingLevel: "off",
    input: {},
    tasks: [],
    events: [],
    artifacts: [],
    usage: emptyUsage(),
  };
  await writeFile(join(store.directory, "valid-run.json"), `${JSON.stringify(valid)}\n`);
  await writeFile(
    join(store.directory, "corrupt-run.json"),
    `${JSON.stringify({ version: 1, id: "corrupt-run", tasks: [] })}\n`,
  );
  const runs = await store.load();
  assert.deepEqual(
    runs.map((run) => run.id),
    ["valid-run"],
  );
});
