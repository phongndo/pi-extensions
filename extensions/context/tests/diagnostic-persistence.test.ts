import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EVENT_TYPE, diagnostics } from "../diagnostics.ts";
import { assistant, harness, user } from "./helpers.ts";

type App = Awaited<ReturnType<typeof harness>>;
function failWrites(app: App, event: string) {
  const append = app.sm.appendCustomEntry.bind(app.sm);
  let failing = true;
  app.sm.appendCustomEntry = (type, data) => {
    if (failing && type === EVENT_TYPE && (data as { event?: string })?.event === event)
      throw new Error("simulated diagnostic write failure");
    return append(type, data);
  };
  return () => {
    failing = false;
  };
}
const measurements = (app: App) =>
  diagnostics(app.sm.getBranch())
    .filter((entry) => entry.event === "post_compaction_usage")
    .map((entry) => [entry.compactionId, entry.inputTokens]);
async function respond(app: App, tokens: number) {
  const message = { ...assistant([], tokens), timestamp: Date.now() + 1000 };
  app.sm.appendMessage(message);
  await app.emit("turn_end", { message });
}
async function compact(app: App, root: string, summary = "Summary") {
  const id = app.sm.appendCompaction(summary, root, 100);
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  return id;
}

for (const recovery of ["next turn", "reload", "disk reopen"] as const) {
  test(`failed usage writes preserve the first response across ${recovery}`, async (t) => {
    const app = await harness(t);
    const root = user(app.sm);
    app.sm.appendMessage(assistant([])); // Flush the session so reopen exercises the archive.
    const id = await compact(app, root);
    const repair = failWrites(app, "post_compaction_usage");
    await respond(app, 111);
    await respond(app, 222);
    assert.deepEqual(measurements(app), []);
    assert.equal(app.notifications.length, 1, "persistent failures warn only once");
    repair();
    let resumed = app;
    if (recovery !== "next turn") {
      await app.emit("session_shutdown");
      if (recovery === "disk reopen")
        resumed = await harness(t, SessionManager.open(app.sm.getSessionFile()!));
      else await app.emit("session_start");
    }
    await respond(resumed, 333);
    assert.deepEqual(measurements(resumed), [[id, 111]]);
    await resumed.emit("session_start");
    await resumed.emit("session_compact"); // Duplicate observation must not restart measurement.
    await respond(resumed, 444);
    assert.deepEqual(measurements(resumed), [[id, 111]]);
  });
}

for (const recovery of ["next turn", "reload", "disk reopen"] as const) {
  test(`new compaction supersedes old attribution even when its diagnostic write fails (${recovery})`, async (t) => {
    const app = await harness(t);
    const root = user(app.sm);
    await compact(app, root, "A");
    const repair = failWrites(app, "compaction");
    const second = await compact(app, root, "B");
    await respond(app, 333);
    assert.ok(
      measurements(app).every(([id]) => id === second),
      "never attribute B's response to A",
    );
    repair();
    let resumed = app;
    if (recovery !== "next turn") {
      await app.emit("session_shutdown");
      if (recovery === "disk reopen")
        resumed = await harness(t, SessionManager.open(app.sm.getSessionFile()!));
      else await app.emit("session_start");
    }
    await respond(resumed, 444);
    assert.deepEqual(measurements(resumed), [[second, 333]]);
    const compactions = diagnostics(resumed.sm.getBranch()).filter(
      (entry) => entry.event === "compaction",
    );
    assert.equal(compactions.filter((entry) => entry.compactionId === second).length, 1);
  });
}

test("failed captured measurements never leak across sibling branches", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const a = await compact(app, root, "A");
  const repair = failWrites(app, "post_compaction_usage");
  await respond(app, 111);
  const aLeaf = app.sm.getLeafId()!;
  app.sm.branch(root);
  await app.emit("session_tree");
  repair();
  const b = await compact(app, root, "B");
  await respond(app, 222);
  assert.deepEqual(measurements(app), [[b, 222]]);
  app.sm.branch(aLeaf);
  await app.emit("session_tree");
  await respond(app, 333);
  assert.deepEqual(measurements(app), [[a, 111]]);
});

test("only persisted ancestry establishes post-compaction causality, not timestamps", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const stale = { ...assistant([], 999), timestamp: Date.now() + 100_000 };
  app.sm.appendMessage(stale);
  const id = await compact(app, root);
  await app.emit("turn_end", { message: stale });
  assert.deepEqual(measurements(app), []);
  const first = { ...assistant([], 111), timestamp: 0 };
  app.sm.appendMessage(first);
  await app.emit("turn_end", { message: first });
  assert.deepEqual(measurements(app), [[id, 111]]);
});

test("already-appended diagnostics are not duplicated if append subsequently throws", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const id = await compact(app, root);
  const append = app.sm.appendCustomEntry.bind(app.sm);
  app.sm.appendCustomEntry = (type, data) => {
    const result = append(type, data);
    if (type === EVENT_TYPE) throw new Error("failure after append");
    return result;
  };
  await respond(app, 111);
  await respond(app, 222);
  assert.deepEqual(measurements(app), [[id, 111]]);
});

test("reconstruction skips failed responses and includes cache input in the first success", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const id = await compact(app, root);
  for (const stopReason of ["error", "aborted", "pending"] as const) {
    const message = { ...assistant([], 999), stopReason };
    app.sm.appendMessage(message);
    await app.emit("turn_end", { message });
  }
  assert.deepEqual(measurements(app), []);
  const first = assistant([], 100);
  first.usage.cacheRead = 20;
  first.usage.cacheWrite = 30;
  app.sm.appendMessage(first);
  await app.emit("turn_end", { message: first });
  assert.deepEqual(measurements(app), [[id, 150]]);
});

test("invalid first successful usage is never silently replaced by a later response", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  await compact(app, root);
  await respond(app, -1);
  await respond(app, 222);
  assert.deepEqual(measurements(app), []);
});
