import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { harness, receipt, toolCall, user } from "./helpers.ts";

test("missing, changed or duplicate original evidence blocks rollover without summary fallback", async (t) => {
  for (const mode of ["missing", "changed", "duplicate"]) {
    const app = await harness(t);
    const original = user(app.sm, "Original evidence");
    await app.newContext();
    const file = app.sm.getSessionFile()!;
    const entries = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const record = entries.find((entry) => entry.id === original)!;
    if (mode === "changed") record.message.content = "Changed on disk";
    if (mode === "missing") entries.splice(entries.indexOf(record), 1);
    if (mode === "duplicate") entries.push(record);
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    assert.deepEqual(await app.beforeCompact(), { cancel: true }, mode);
    assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.match(app.notifications.at(-1)!, /No summary was generated/);
  }
});

test("queued steering blocks both requested and automatic rollover", async (t) => {
  const app = await harness(t);
  user(app.sm);
  app.controls.pending = true;
  await assert.rejects(app.newContext(), /queued input/);
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});

test("switching context off after a terminating request stops without fallback or continuation", async (t) => {
  const app = await harness(t);
  user(app.sm);
  assert.equal((await app.newContext()).terminate, true);
  await app.command("off");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});

test("aborting the tool signal before settlement cancels its pending rollover", async (t) => {
  const app = await harness(t);
  user(app.sm);
  toolCall(app.sm);
  const controller = new AbortController();
  const result = await app.execute("new_context", {}, "window-call", controller.signal);
  assert.equal(result.terminate, true);
  receipt(app.sm);
  controller.abort();
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});

test("shutdown/restart cannot carry a pending rollover into a new runtime", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.emit("session_shutdown");
  assert.equal(app.statuses.get("context"), undefined);
  await app.emit("session_start");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
});
