import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { currentNotes, recall } from "../model.ts";
import { saveEnabled } from "../state.ts";
import { diagnostics } from "../diagnostics.ts";
import { assistant, harness, toolCall, user } from "./helpers.ts";

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
  await app.newContext();
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
  await app.newContext();
  await writeFile(app.path, "bad json");
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
  assert.equal(app.statuses.get("context"), "ctxt exp !");
  await assert.rejects(app.execute("recall", {}), /disabled/);
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
    // Manual/automatic rollover needs no note, checkpoint or model-authored handoff.
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
    assert.match(active, /recall/);
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
    assert.deepEqual(
      await app.beforeCompact({ reason: "overflow" }),
      { cancel: true },
      "fresh overflow cannot loop",
    );
    user(app.sm, `Continue iteration ${i}`);
  }
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  assert.match(
    JSON.stringify(recall(reopened.getBranch(), { entryId: output })),
    /ARCHIVED ORIGINAL TOOL OUTPUT/,
  );
  assert.equal(reopened.getBranch().filter((entry) => entry.type === "compaction").length, 3);
});

test("sibling batches can request rollover, newer steering cancels continuation, verification failure cancels compaction", async (t) => {
  const app = await harness(t);
  user(app.sm);
  toolCall(app.sm, "window-call", [
    { type: "toolCall", id: "sibling", name: "bash", arguments: {} },
  ]);
  assert.equal((await app.execute("new_context", {})).terminate, true);
  user(app.sm, "Late steering: do not touch the database");
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0);
  const broken = await harness(t, {
    verify: async () => {
      throw new Error("disk full");
    },
  });
  user(broken.sm);
  await broken.newContext();
  assert.deepEqual(await broken.beforeCompact(), { cancel: true });
  assert.match(broken.notifications.at(-1)!, /disk full.*No summary/);
});

test("in-memory sessions never discard history or fall back to a summary", async (t) => {
  const app = await harness(t, {}, SessionManager.inMemory());
  user(app.sm);
  toolCall(app.sm);
  await assert.rejects(app.execute("new_context", {}), /persisted session/);
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
});

test("compaction rechecks disk, current branch, cancellation, tools, and custom instructions", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  assert.deepEqual(await app.beforeCompact({ customInstructions: "Preserve the deployment log" }), {
    cancel: true,
  });
  app.controls.tools = ["notes"];
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
  app.controls.tools = ["notes", "recall", "new_context"];
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual(await app.beforeCompact({ signal: abort.signal }), { cancel: true });
  await writeFile(app.sm.getSessionFile()!, "");
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
});

test("reset is deferred until agent_settled; callbacks continue only the same idle task", async (t) => {
  const app = await harness(t);
  user(app.sm);
  const result = await app.newContext();
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
  await app.newContext();
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
    await app.newContext();
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

test("failed and aborted transitions both stop without restarting unchanged history", async (t) => {
  for (const error of [new Error("No API key"), new Error("Compaction cancelled")]) {
    const app = await harness(t);
    user(app.sm);
    await app.newContext();
    await app.emit("agent_settled");
    app.compactions[0]!.onError!(error);
    assert.equal(app.sent.length, 0);
    assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
  }
});

test("late user input between verification and completion prevents continuation", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.emit("agent_settled");
  const compact = (await app.beforeCompact())!.compaction!;
  user(app.sm, "Actually stop here");
  app.compactions[0]!.onComplete!(compact);
  assert.equal(app.sent.length, 0);
});

test("a competing compaction result cannot consume a summary-free continuation", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.emit("agent_settled");
  await app.beforeCompact();
  const id = app.sm.appendCompaction("another policy", app.sm.getLeafId()!, 100, {}, true);
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  app.compactions[0]!.onComplete!({
    summary: "another policy",
    firstKeptEntryId: id,
    tokensBefore: 100,
  });
  assert.equal(app.sent.length, 0);
  assert.match(app.notifications.at(-1)!, /overrode/);
});

test("unavailable memory tools at the budget limit stop instead of silently continuing", async (t) => {
  const app = await harness(t);
  app.controls.tools = ["read"];
  app.controls.tokens = 120_000;
  await app.emit("turn_end", { message: assistant([{ type: "text", text: "Done" }], 120_000) });
  assert.equal(app.controls.aborts, 1);
  assert.match(app.notifications.at(-1)!, /unavailable/);
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 0);
});

test("branch changes during asynchronous disk verification prevent replacement", async (t) => {
  let mutate = () => {};
  const app = await harness(t, {
    verify: async () => {
      mutate();
    },
  });
  user(app.sm);
  await app.newContext();
  mutate = () => {
    user(app.sm, "steering arrived during verification");
  };
  assert.deepEqual(await app.beforeCompact(), { cancel: true });
  assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
});
