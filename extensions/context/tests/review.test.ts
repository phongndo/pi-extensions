import assert from "node:assert/strict";
import test from "node:test";
import { assistant, harness, user } from "./helpers.ts";
import { diagnostics } from "../diagnostics.ts";

for (const interrupted of ["busy", "pending"] as const) {
  test(`a ${interrupted} completion cannot strand the next rollover request`, async (t) => {
    const app = await harness(t);
    user(app.sm);
    await app.newContext();
    await app.emit("agent_settled");
    const compact = (await app.beforeCompact())!.compaction!;
    if (interrupted === "busy") app.controls.idle = false;
    else app.controls.pending = true;
    app.compactions[0]!.onComplete!(compact);
    assert.equal(app.sent.length, 0);
    app.controls.idle = true;
    app.controls.pending = false;
    user(app.sm, "Next task");
    await app.newContext("next-window");
    await app.emit("agent_settled");
    assert.equal(app.compactions.length, 2);
  });
}

test("a failed native compaction consumes its pending rollover instead of retrying at settlement", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.beforeCompact();
  await app.emit("session_compact_failed", { aborted: false, errorMessage: "disk full" });
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
  await app.newContext("retry-explicitly");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 1);
});

test("an unprepared compaction with missing window IDs is never classified as fresh", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.emit("session_compact", {
    compactionEntry: {
      type: "compaction",
      id: "unprepared",
      fromHook: true,
      retainedTail: [],
      details: { context: { version: 2 } },
      tokensBefore: 100,
    },
  });
  assert.equal(diagnostics(app.sm.getBranch()).at(-1)?.outcome, "other");
});

test("parallel new_context calls coalesce without spurious preference errors", async (t) => {
  const app = await harness(t);
  user(app.sm);
  app.sm.appendMessage(assistant([]));
  const results = await Promise.allSettled([
    app.execute("new_context", {}, "first"),
    app.execute("new_context", {}, "second"),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 1);
});
