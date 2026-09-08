import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withEvidenceIds } from "../provenance.ts";
import { EVENT_TYPE, diagnostics, pendingUsage } from "../diagnostics.ts";
import { recall, type RecallInput } from "../model.ts";
import { assistant, harness, user } from "./helpers.ts";

function results(sm: SessionManager, input: RecallInput) {
  return recall(sm.getBranch(), input) as {
    results: { entryId: string }[];
    nextCursor: string | null;
  };
}

test("filtered original user evidence survives two resets; current-window noise and summaries do not crowd it out", () => {
  const sm = SessionManager.inMemory();
  const wanted = user(sm, "Use one Chrome instance; do not deploy.");
  sm.appendCompaction("Chrome summary without exact requirements", wanted, 1000);
  const other = user(sm, "Chrome follow-up");
  sm.appendCompaction("Chrome summary again", other, 1000);
  user(sm, "Chrome current chatter");
  const input = {
    query: "Chrome",
    source: "original",
    role: "user",
    window: "previous",
    limit: 1,
  } as const;
  const first = results(sm, input);
  assert.equal(first.results[0]!.entryId, other);
  assert.ok(first.nextCursor);
  const now = user(sm, "Chrome newer chatter");
  sm.appendCompaction("Yet another Chrome summary", now, 1000);
  const second = results(sm, { ...input, cursor: first.nextCursor! });
  assert.deepEqual(
    second.results.map((r) => r.entryId),
    [wanted],
    "relative window stays pinned during pagination",
  );
  for (const changed of [
    { role: "assistant" },
    { source: "derived" },
    { window: "current" },
    { toolName: "bash" },
  ])
    assert.throws(
      () => results(sm, { ...input, ...changed, cursor: first.nextCursor! } as RecallInput),
      /Cursor/,
    );
  assert.throws(() => recall(sm.getBranch(), { entryId: wanted, source: "original" }), /alone/);
  sm.branch(wanted);
  user(sm, "Sibling Chrome");
  assert.throws(() => results(sm, { ...input, cursor: first.nextCursor! }), /branch/);
});

test("tool/source/window filters compose; default behavior and old cursors remain supported", () => {
  const sm = SessionManager.inMemory();
  const first = user(sm, "needle");
  user(sm, "needle two");
  const tool = sm.appendMessage({
    role: "toolResult",
    toolCallId: "t",
    toolName: "bash",
    content: [{ type: "text", text: "needle failure" }],
    isError: true,
    timestamp: 12,
  });
  const page = results(sm, { query: "needle", limit: 1 });
  const old = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
  old.version = 1;
  delete old.filters;
  assert.equal(
    results(sm, { query: "needle", cursor: Buffer.from(JSON.stringify(old)).toString("base64url") })
      .results.length,
    2,
  );
  assert.deepEqual(
    results(sm, { toolName: "bash", source: "original" }).results.map((r) => r.entryId),
    [tool],
  );
  assert.equal(results(sm, { window: "previous" }).results.length, 0);
  assert.equal(results(sm, { window: "current" }).results.length, 3);
  sm.appendCompaction("needle summary", first, 100);
  assert.equal(results(sm, { source: "derived" }).results.length, 1);
  for (const bad of [
    { role: "system" },
    { source: "bogus" },
    { window: "bogus" },
    { toolName: " " },
  ])
    assert.throws(() => recall(sm.getBranch(), bad as RecallInput));
});

test("evidence markers are stable presentation-only, omit private/recursive messages, and skip ambiguous or transformed sources", () => {
  const sm = SessionManager.inMemory();
  const id = user(sm, "Keep the original worktree untouched");
  sm.appendMessage(
    assistant([
      { type: "thinking", thinking: "PRIVATE", thinkingSignature: "SIGNED" },
      { type: "text", text: "visible" },
    ]),
  );
  const toolId = sm.appendMessage({
    role: "toolResult",
    toolCallId: "t",
    toolName: "bash",
    content: [{ type: "text", text: "red test" }],
    isError: true,
    timestamp: 23,
  });
  sm.appendMessage({
    role: "toolResult",
    toolCallId: "r",
    toolName: "recall",
    content: [{ type: "text", text: "recursive" }],
    isError: false,
    timestamp: 24,
  });
  const messages = sm.buildSessionContext().messages;
  const before = JSON.stringify(sm.getEntries());
  const marked = withEvidenceIds(messages, sm.getBranch());
  assert.match(JSON.stringify(marked[0]), new RegExp(id));
  assert.equal(marked[1], messages[1], "signed assistant untouched");
  assert.match(JSON.stringify(marked[2]), new RegExp(toolId));
  assert.equal(marked[3], messages[3]);
  assert.equal(JSON.stringify(sm.getEntries()), before);
  assert.deepEqual(
    withEvidenceIds(marked, sm.getBranch()),
    marked,
    "idempotent on an already transformed context",
  );
  const original = messages[0]!;
  assert.equal(original.role, "user");
  if (original.role !== "user") throw new Error("Expected user");
  sm.appendMessage(original);
  assert.equal(
    withEvidenceIds(messages, sm.getBranch())[0],
    messages[0],
    "ambiguous identical user records are not mislabeled",
  );
});

test("exp provenance and milestone guidance encourage source-backed notes without quotas", async (t) => {
  const app = await harness(t);
  const id = user(app.sm);
  await app.command("exp");
  const presented = await app.emit("context", { messages: app.sm.buildSessionContext().messages });
  assert.match(JSON.stringify(presented), new RegExp(id));
  const guidance = await app.emit("before_agent_start", { systemPrompt: "base" });
  assert.match(JSON.stringify(guidance), /confirmed failure, decision, or completed milestone/);
  assert.match(JSON.stringify(guidance), /Do not reread evidence already available/);
});

test("durable diagnostics pair rollover outcomes with usage", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  const preparationLeaf = app.sm.getLeafId();
  const prepared = (await app.beforeCompact())!.compaction!;
  assert.ok(prepared);
  const id = app.sm.appendCompaction(
    prepared.summary,
    prepared.firstKeptEntryId,
    prepared.tokensBefore,
    prepared.details,
    true,
  );
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  await app.emit("agent_settled");
  await app.emit("turn_end", {
    message: {
      ...assistant([{ type: "text", text: "continued" }], 400),
      timestamp: Date.now() + 1000,
    },
  });
  await app.emit("turn_end", { message: assistant([{ type: "text", text: "more" }], 500) });
  const events = diagnostics(app.sm.getBranch());
  assert.equal(events.filter((e) => e.event === "reset_requested").length, 1);
  assert.equal(events.find((e) => e.event === "compaction")!.outcome, "fresh");
  assert.equal(events.find((e) => e.event === "post_reset_usage")!.inputTokens, 400);
  assert.equal(events.filter((e) => e.event === "post_reset_usage").length, 1);
  assert.equal(events.filter((e) => e.event === "resumed").length, 1);
  assert.ok(app.sm.getEntry(preparationLeaf!));
  assert.equal(
    JSON.stringify(recall(app.sm.getBranch(), { query: EVENT_TYPE })).includes('"role":"custom"'),
    false,
  );
  await app.command("status");
  assert.match(app.notifications.at(-1)!, /fresh.*400 tokens/);
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  assert.deepEqual(diagnostics(reopened.getBranch()), events);
});

test("failure diagnostics exclude raw errors, record once and never resume", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.emit("agent_settled");
  await app.emit("session_compact_failed", { aborted: false, errorMessage: "SECRET" });
  app.compactions[0]!.onError!(new Error("SECRET"));
  assert.equal(app.sent.length, 0);
  assert.equal(
    diagnostics(app.sm.getBranch()).filter((e) => e.event === "compaction_failed").length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(diagnostics(app.sm.getBranch())), /SECRET/);
});

test("usage attribution accepts a persisted post-compaction response sharing the boundary millisecond", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const id = app.sm.appendCompaction("stock summary", root, 100);
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  const response = {
    ...assistant([{ type: "text", text: "READY" }], 123),
    timestamp: Date.parse(app.sm.getEntry(id)!.timestamp),
  };
  app.sm.appendMessage(response);
  await app.emit("turn_end", { message: response });
  assert.equal(
    diagnostics(app.sm.getBranch()).find((event) => event.event === "post_reset_usage")
      ?.inputTokens,
    123,
  );
});

test("usage attribution survives reload, rejects pre-boundary turns and stays branch-local", async (t) => {
  const app = await harness(t);
  const root = user(app.sm);
  const id = app.sm.appendCompaction("stock summary", root, 100);
  await app.emit("session_compact", { compactionEntry: app.sm.getEntry(id) });
  assert.equal(pendingUsage(app.sm.getBranch()), id);
  await app.emit("session_start");
  await app.emit("turn_end", { message: { ...assistant([]), timestamp: 0 } });
  assert.equal(pendingUsage(app.sm.getBranch()), id);
  await app.emit("turn_end", { message: { ...assistant([], 321), timestamp: Date.now() + 1000 } });
  assert.equal(pendingUsage(app.sm.getBranch()), undefined);
  assert.equal(diagnostics(app.sm.getBranch()).at(-1)?.inputTokens, 321);
  app.sm.branch(root);
  await app.emit("session_tree");
  assert.equal(pendingUsage(app.sm.getBranch()), undefined);
  await app.emit("turn_end", { message: { ...assistant([], 999), timestamp: Date.now() + 1000 } });
  assert.equal(
    diagnostics(app.sm.getBranch()).some((event) => event.event === "post_reset_usage"),
    false,
  );
});
