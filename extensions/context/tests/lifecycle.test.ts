import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_TYPE, currentNotes, latestCheckpoint, recall } from "../model.ts";
import { saveEnabled } from "../state.ts";
import { diagnostics } from "../diagnostics.ts";
import { assistant, checkpoint, harness, receipt, toolCall, user } from "./helpers.ts";

test("/context default|exp|status persists globally and preserves notes while disabled", async (t) => {
  const app = await harness(t);
  assert.equal(app.statuses.get("context"), "ctxt exp");
  const request = user(app.sm);
  const note = await app.execute("notes", {
    action: "write",
    name: "findings",
    text: "Original evidence",
    references: [request],
  });
  const id = (note.details as { entryId: string }).entryId;
  await app.saveCheckpoint();
  await app.command("off");
  assert.equal(app.notifications.at(-1), "Context default");
  await assert.rejects(app.execute("recall", { entryId: id }), /disabled/);
  assert.equal(await app.beforeCompact(), undefined);
  assert.deepEqual(
    app.commands.get("context")!.getArgumentCompletions!(""),
    ["default", "exp", "status"].map((value) => ({ value, label: value })),
  );
  await app.command("invalid");
  assert.match(app.notifications.at(-1)!, /Usage:/);
  const second = await harness(t, { statePath: app.path });
  assert.equal(second.statuses.get("context"), "ctxt default");
  await second.command("on");
  await app.command("status");
  assert.match(app.notifications.at(-1)!, /^Context exp · No recorded compaction/);
  assert.match(JSON.stringify(await app.execute("recall", { entryId: id })), /Original evidence/);
  const before = await readFile(app.path, "utf8");
  await app.command("status");
  assert.equal(await readFile(app.path, "utf8"), before);
});

test("external preference changes refresh the status while idle", async (t) => {
  const app = await harness(t, { pollMs: 10 });
  await saveEnabled(app.path, false);
  for (let i = 0; i < 100 && app.statuses.get("context") !== "ctxt default"; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(app.statuses.get("context"), "ctxt default");
});

test("corrupt preferences fail safe and /context on repairs them", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.saveCheckpoint();
  await writeFile(app.path, "bad json");
  assert.equal(await app.beforeCompact(), undefined);
  assert.equal(app.statuses.get("context"), "ctxt default !");
  assert.ok(!app.controls.tools.includes("recall"));
  await app.command("on");
  assert.equal(app.statuses.get("context"), "ctxt exp");
});

test("reminders are transient, budget gated, and absent when disabled or tools unavailable", async (t) => {
  const app = await harness(t);
  const event = { messages: [] };
  assert.equal(await app.emit("context", event), undefined);
  app.controls.tokens = 110_000;
  const result = (await app.emit("context", event)) as { messages: unknown[] };
  assert.equal(result.messages.length, 1);
  assert.equal(diagnostics(app.sm.getBranch()).filter((e) => e.event === "reminder").length, 1);
  await app.emit("context", event);
  assert.equal(diagnostics(app.sm.getBranch()).filter((e) => e.event === "reminder").length, 1);
  assert.equal(event.messages.length, 0);
  await app.command("off");
  assert.equal(await app.emit("context", event), undefined);
  await app.command("on");
  app.controls.tools = ["read"];
  assert.equal(await app.emit("context", event), undefined);
  assert.equal(await app.emit("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("note writes validate ancestry, revision and size, and reconstruct after reopening/forking", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  app.sm.appendMessage(assistant([{ type: "text", text: "Start" }]));
  await app.execute("notes", {
    action: "write",
    name: "findings",
    text: "one",
    references: [root],
  });
  const old = currentNotes(app.sm.getBranch()).get("findings")!.entryId;
  await assert.rejects(
    app.execute("notes", { action: "write", name: "findings", text: "two" }),
    /requires revision/,
  );
  await assert.rejects(
    app.execute("notes", { action: "append", name: "findings", text: "two", revision: "bogus" }),
    /revision changed/,
  );
  await assert.rejects(
    app.execute("notes", { action: "write", name: "../outside", text: "two" }),
    /logical/,
  );
  await assert.rejects(
    app.execute("notes", { action: "write", name: "bad", text: "two", references: ["sibling"] }),
    /active branch|this branch/,
  );
  await assert.rejects(
    app.execute("notes", { action: "append", name: "findings", text: "x".repeat(12000) }),
    /exceeds/,
  );
  await app.execute("notes", { action: "append", name: "findings", text: "\ntwo" });
  assert.equal(currentNotes(app.sm.getBranch()).get("findings")!.data.text, "one\ntwo");
  const file = app.sm.getSessionFile()!;
  const reopened = SessionManager.open(file);
  assert.equal(currentNotes(reopened.getBranch()).get("findings")!.data.text, "one\ntwo");
  const fork = reopened.createBranchedSession(old)!;
  const forked = SessionManager.open(fork);
  assert.equal(currentNotes(forked.getBranch()).get("findings")!.data.text, "one");
  const current = currentNotes(app.sm.getBranch()).get("findings")!.entryId;
  await app.execute("notes", { action: "delete", name: "findings", revision: current });
  assert.equal(currentNotes(app.sm.getBranch()).size, 0);
});

test("fresh reset drops every old active message but retains exact evidence over multiple resets and resume", async (t) => {
  const app = await harness(t);
  const original = user(app.sm, "ORIGINAL USER REQUEST: fix without deploying");
  app.sm.appendMessage(assistant([{ type: "text", text: "OLD ASSISTANT TEXT" }]));
  const output = app.sm.appendMessage({
    role: "toolResult",
    toolCallId: "read1",
    toolName: "read",
    content: [{ type: "text", text: "ARCHIVED ORIGINAL TOOL OUTPUT" }],
    isError: false,
    timestamp: Date.now(),
  });
  for (let i = 0; i < 3; i++) {
    const saved = await app.saveCheckpoint(false, `checkpoint-${i}`);
    assert.equal(saved.terminate, undefined);
    const result = await app.beforeCompact();
    assert.ok(result?.compaction);
    const compact = result.compaction;
    const id = app.sm.appendCompaction(
      compact.summary,
      compact.firstKeptEntryId,
      compact.tokensBefore,
      compact.details,
      true,
    );
    await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
    const active = JSON.stringify(app.sm.buildSessionContext().messages);
    assert.match(active, /First fix failed/);
    assert.doesNotMatch(
      active,
      /ORIGINAL USER REQUEST|OLD ASSISTANT TEXT|ARCHIVED ORIGINAL TOOL OUTPUT|toolCall|toolResult/,
    );
    assert.match(
      JSON.stringify(recall(app.sm.getBranch(), { entryId: output })),
      /ARCHIVED ORIGINAL TOOL OUTPUT/,
    );
    assert.match(
      JSON.stringify(recall(app.sm.getBranch(), { entryId: original })),
      /ORIGINAL USER REQUEST/,
    );
    assert.equal(await app.beforeCompact(), undefined, "cannot reuse a consumed checkpoint");
    user(app.sm, `Continue iteration ${i}`);
  }
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  assert.match(
    JSON.stringify(recall(reopened.getBranch(), { entryId: output })),
    /ARCHIVED ORIGINAL TOOL OUTPUT/,
  );
  assert.equal(reopened.getBranch().filter((entry) => entry.type === "compaction").length, 3);
});

test("checkpoint must be solo, references latest user, and stale/failed saves use normal compaction", async (t) => {
  const app = await harness(t);
  const request = user(app.sm);
  toolCall(app.sm, "checkpoint-call", [
    { type: "toolCall", id: "sibling", name: "bash", arguments: {} },
  ]);
  await assert.rejects(
    app.execute("notes", { action: "checkpoint", checkpoint, reset: true }),
    /alone/,
  );
  assert.equal(latestCheckpoint(app.sm.getBranch()), undefined);
  assert.equal(await app.beforeCompact(), undefined);
  await app.saveCheckpoint();
  assert.ok(latestCheckpoint(app.sm.getBranch())!.data.references.includes(request));
  user(app.sm, "Late steering: do not touch the database");
  assert.equal(await app.beforeCompact(), undefined);
  const broken = await harness(t, {
    verify: async () => {
      throw new Error("disk full");
    },
  });
  user(broken.sm);
  toolCall(broken.sm);
  await assert.rejects(
    broken.execute("notes", { action: "checkpoint", checkpoint, reset: true }),
    /disk full/,
  );
  receipt(broken.sm, "checkpoint-call", true);
  assert.equal(await broken.beforeCompact(), undefined);
  await broken.emit("agent_settled");
  assert.equal(broken.compactions.length, 0);
});

test("in-memory sessions never discard history through a fresh checkpoint", async (t) => {
  const app = await harness(t, {}, SessionManager.inMemory());
  user(app.sm);
  toolCall(app.sm);
  await assert.rejects(
    app.execute("notes", { action: "checkpoint", checkpoint, reset: true }),
    /persisted session/,
  );
  receipt(app.sm);
  assert.equal(await app.beforeCompact(), undefined);
});

test("compaction rechecks disk, current branch, cancellation, tools, and custom instructions", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.saveCheckpoint();
  assert.equal(
    await app.beforeCompact({ customInstructions: "Preserve the deployment log" }),
    undefined,
  );
  app.controls.tools = ["notes"];
  assert.equal(await app.beforeCompact(), undefined);
  app.controls.tools = ["notes", "recall"];
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await app.beforeCompact({ signal: abort.signal }), { cancel: true });
  await writeFile(app.sm.getSessionFile()!, "");
  assert.equal(await app.beforeCompact(), undefined);
});

test("reset is deferred until agent_settled; callbacks continue only the same idle task", async (t) => {
  const app = await harness(t);
  user(app.sm);
  const result = await app.saveCheckpoint(true);
  assert.equal(result.terminate, true);
  assert.equal(app.compactions.length, 0);
  await app.emit("turn_end");
  assert.equal(app.compactions.length, 0);
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 1);
  const compact = (await app.beforeCompact())!.compaction!;
  app.compactions[0]!.onComplete!(compact);
  assert.equal(app.sent.length, 1);
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 1);
});

test("automatic threshold reset continues once without a second manual compaction", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.saveCheckpoint(true);
  const compact = (await app.beforeCompact())!.compaction!;
  const id = app.sm.appendCompaction(
    compact.summary,
    compact.firstKeptEntryId,
    compact.tokensBefore,
    compact.details,
    true,
  );
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  await app.emit("agent_settled");
  assert.equal(app.sent.length, 1);
  assert.equal(app.compactions.length, 0);
});

test("cancellation, tree navigation, shutdown and queued steering never spuriously restart the agent", async (t) => {
  for (const mode of ["abort", "tree", "shutdown", "pending", "busy"]) {
    const app = await harness(t);
    user(app.sm);
    await app.saveCheckpoint(true);
    await app.emit("agent_settled");
    if (mode === "abort") await app.emit("session_compact_failed", { aborted: true });
    if (mode === "tree") await app.emit("session_tree");
    if (mode === "shutdown") await app.emit("session_shutdown");
    if (mode === "pending") app.controls.pending = true;
    if (mode === "busy") app.controls.idle = false;
    app.compactions[0]!.onComplete!({ summary: "done", firstKeptEntryId: "x", tokensBefore: 1 });
    assert.equal(app.sent.length, 0, mode);
  }
});

test("failed manual transition resumes unchanged history, but an aborted one does not", async (t) => {
  for (const error of [new Error("No API key"), new Error("Compaction cancelled")]) {
    const app = await harness(t);
    user(app.sm);
    await app.saveCheckpoint(true);
    await app.emit("agent_settled");
    app.compactions[0]!.onError!(error);
    assert.equal(app.sent.length, error.message.includes("cancelled") ? 0 : 1);
    assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  }
});

test("branch changes during asynchronous disk verification prevent replacement", async (t) => {
  let mutate = () => {};
  const app = await harness(t, {
    verify: async () => {
      mutate();
    },
  });
  user(app.sm);
  await app.saveCheckpoint();
  mutate = () => {
    user(app.sm, "steering arrived during verification");
  };
  assert.equal(await app.beforeCompact(), undefined);
  assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  assert.ok(
    app.sm
      .getBranch()
      .some((entry) => entry.type === "custom" && entry.customType === CHECKPOINT_TYPE),
  );
});
