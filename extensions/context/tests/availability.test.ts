import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assistant, harness, user } from "./helpers.ts";

test("recall has no command, preference, or mode footer and is available immediately", async (t) => {
  const app = await harness(t);
  assert.deepEqual([...app.commands.keys()], []);
  assert.equal(app.statuses.size, 0);
  assert.deepEqual([...app.tools.keys()], ["recall"]);
  const id = user(app.sm);
  const before = JSON.stringify(app.sm.getEntries());
  assert.match(JSON.stringify(await app.execute("recall", { entryId: id })), /without deploying/);
  assert.match(
    JSON.stringify(await app.emit("before_agent_start", { systemPrompt: "base" })),
    /Context recall/,
  );
  assert.match(
    JSON.stringify(await app.emit("context", { messages: app.sm.buildSessionContext().messages })),
    new RegExp(`evidence:${id}`),
  );
  assert.equal(JSON.stringify(app.sm.getEntries()), before);
  await assert.rejects(readFile(join(app.root, "context.json")), { code: "ENOENT" });
});

test("obsolete preferences are ignored and never rewritten", async (t) => {
  const app = await harness(t);
  const path = join(app.root, "context.json");
  for (const text of ['{"version":4,"mode":"default"}', "not json"]) {
    await writeFile(path, text);
    await app.emit("session_shutdown");
    await app.emit("session_start");
    assert.match(
      JSON.stringify(await app.emit("before_agent_start", { systemPrompt: "base" })),
      /Context recall/,
    );
    await app.execute("recall", {});
    assert.equal(await readFile(path, "utf8"), text);
    assert.deepEqual(app.notifications, []);
  }
});

test("caller tool exclusions survive prompts, settlement, shutdown and restart", async (t) => {
  const app = await harness(t);
  user(app.sm);
  app.controls.tools = ["read"];
  for (const idle of [false, true]) {
    app.controls.idle = idle;
    await app.emit("agent_settled");
    assert.equal(await app.emit("before_agent_start", { systemPrompt: "base" }), undefined);
    assert.equal(
      await app.emit("context", { messages: app.sm.buildSessionContext().messages }),
      undefined,
    );
    await assert.rejects(app.execute("recall", {}), /unavailable/);
    await app.emit("session_shutdown");
    await assert.rejects(app.execute("recall", {}), /unavailable/);
    await app.emit("session_start");
    assert.deepEqual(app.controls.tools, ["read"]);
  }
  app.controls.tools = ["read", "recall", "other-extension-tool"];
  await app.execute("recall", {});
  assert.match(
    JSON.stringify(await app.emit("before_agent_start", { systemPrompt: "base" })),
    /Context recall/,
  );
  assert.deepEqual(app.controls.tools, ["read", "recall", "other-extension-tool"]);
});

test("parallel recall calls are read-only and respect cancellation", async (t) => {
  const app = await harness(t);
  const id = user(app.sm);
  const values = await Promise.all([
    app.execute("recall", { entryId: id }),
    app.execute("recall", { entryId: id }),
  ]);
  assert.deepEqual(values[0], values[1]);
  await assert.rejects(app.execute("recall", {}, "aborted", AbortSignal.abort()));
});

test("recall never takes over compaction, aborts or continuations", async (t) => {
  const app = await harness(t);
  user(app.sm);
  assert.equal(app.handlers.has("session_before_compact"), false);
  app.controls.tokens = 200_000;
  app.controls.pending = true;
  for (const reason of ["manual", "threshold", "overflow"] as const)
    assert.equal(
      await app.beforeCompact({
        reason,
        customInstructions: "Keep the log",
        signal: AbortSignal.abort(),
      }),
      undefined,
    );
  for (const stopReason of ["stop", "toolUse", "error", "aborted"] as const) {
    await app.emit("turn_end", {
      message: {
        ...assistant([], 200_000),
        stopReason,
        errorMessage: "maximum context length exceeded",
      },
    });
    await app.emit("agent_settled");
  }
  await app.emit("session_compact_failed", { aborted: false, errorMessage: "SECRET" });
  assert.equal(app.controls.aborts, 0);
  assert.deepEqual(app.compactions, []);
  assert.deepEqual(app.sent, []);
  assert.doesNotMatch(
    JSON.stringify(app.sm.getEntries()),
    /SECRET|context.request|context.window|context.note/,
  );
});
