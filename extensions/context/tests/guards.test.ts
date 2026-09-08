import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { CHECKPOINT_TYPE } from "../model.ts";
import { checkpoint, harness, receipt, toolCall, user } from "./helpers.ts";

test("a persisted checkpoint is insufficient if any original branch evidence is missing or changed", async (t) => {
  for (const mode of ["missing", "changed", "duplicate"]) {
    const app = await harness(t);
    const original = user(app.sm, "Original evidence");
    await app.saveCheckpoint();
    const file = app.sm.getSessionFile()!;
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const record = entries.find((entry) => entry.id === original)!;
    if (mode === "changed") record.message.content = "Changed on disk";
    if (mode === "missing") entries.splice(entries.indexOf(record), 1);
    if (mode === "duplicate") entries.push(record);
    assert.ok(entries.some((entry) => entry.customType === CHECKPOINT_TYPE));
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.equal(await app.beforeCompact(), undefined, mode);
    assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  }
});

test("queued steering blocks both requested and automatic fresh resets", async (t) => {
  const app = await harness(t);
  user(app.sm);
  app.controls.pending = true;
  const result = await app.saveCheckpoint(true);
  assert.equal(result.terminate, undefined);
  assert.equal(await app.beforeCompact(), undefined);
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});

test("switching context off after a terminating checkpoint continues the task without a reset", async (t) => {
  const app = await harness(t);
  user(app.sm);
  assert.equal((await app.saveCheckpoint(true)).terminate, true);
  await app.command("off");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 1);
});

test("aborting the checkpoint's tool signal before settlement cancels its pending reset", async (t) => {
  const app = await harness(t);
  user(app.sm);
  toolCall(app.sm);
  const controller = new AbortController();
  const result = await app.execute(
    "notes",
    { action: "checkpoint", checkpoint, reset: true },
    "checkpoint-call",
    controller.signal,
  );
  assert.equal(result.terminate, true);
  receipt(app.sm);
  controller.abort();
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});

test("shutdown/restart cannot carry a pending reset into a new runtime", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.saveCheckpoint(true);
  await app.emit("session_shutdown");
  assert.equal(app.statuses.get("context"), undefined);
  await app.emit("session_start");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});
