import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NOTE_TYPE, currentNotes, evidenceFor, recall, type NoteData } from "../model.ts";
import { assistant, receipt, user } from "./helpers.ts";

test("recall searches original tool evidence beyond stock summary truncation and reads by offset", () => {
  const sm = SessionManager.inMemory();
  user(sm);
  const text = "x".repeat(10_000) + "First fix failed\n" + "y".repeat(20_000);
  const id = sm.appendMessage({
    role: "toolResult",
    toolCallId: "bash1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: Date.now(),
  });
  const result = recall(sm.getBranch(), { query: "First fix", limit: 5 }) as {
    results: { entryId: string; snippet: string; offset: number; isError: boolean }[];
  };
  assert.equal(result.results[0]!.entryId, id);
  assert.match(result.results[0]!.snippet, /First fix failed/);
  assert.equal(result.results[0]!.isError, true);
  const read = recall(sm.getBranch(), { entryId: id, offset: 10_000, limit: 4000 }) as {
    text: string;
    nextOffset: number;
    totalChars: number;
  };
  assert.ok(read.text.startsWith("First fix failed"));
  assert.equal(read.text.length, 4000);
  assert.equal(read.nextOffset, 14_000);
  assert.equal(read.totalChars, text.length);
  assert.throws(() => recall(sm.getBranch(), { entryId: id, offset: text.length + 1 }));
  assert.throws(() => recall(sm.getBranch(), { entryId: id, query: "x" }));
  assert.throws(() => recall(sm.getBranch(), { query: "x", limit: 21 }));
  assert.throws(() => recall(sm.getBranch(), { query: "x", offset: 1 }));
});

test("recall uses a stable ancestor snapshot for pagination and never reads siblings", () => {
  const sm = SessionManager.inMemory();
  const base = user(sm, "base");
  const ids = [user(sm, "needle one"), user(sm, "needle two"), user(sm, "needle three")];
  const first = recall(sm.getBranch(), { query: "needle", limit: 1 }) as {
    nextCursor: string;
    results: { entryId: string }[];
  };
  assert.equal(first.results[0]!.entryId, ids[2]);
  user(sm, "needle four added after pagination started");
  const second = recall(sm.getBranch(), {
    query: "needle",
    limit: 1,
    cursor: first.nextCursor,
  }) as { results: { entryId: string }[] };
  assert.equal(second.results[0]!.entryId, ids[1]);
  assert.throws(() => recall(sm.getBranch(), { query: "other", cursor: first.nextCursor }));
  assert.throws(() => recall(sm.getBranch(), { cursor: "not-json" }));
  sm.branch(base);
  user(sm, "other branch");
  assert.ok(sm.getEntries().some((entry) => entry.id === ids[0]));
  assert.throws(() => recall(sm.getBranch(), { entryId: ids[0]! }));
  assert.throws(() => recall(sm.getBranch(), { query: "needle", cursor: first.nextCursor }));
  assert.deepEqual(
    (recall(sm.getBranch(), { query: "needle" }) as { results: unknown[] }).results,
    [],
  );
});

test("note revisions replay per branch; search hides replaced/deleted notes but exact IDs remain readable", () => {
  const sm = SessionManager.inMemory();
  const base = user(sm);
  const data: NoteData = {
    version: 1,
    name: "findings",
    text: "First fix",
    references: [base],
    deleted: false,
  };
  const old = sm.appendCustomEntry(NOTE_TYPE, data);
  const current = sm.appendCustomEntry(NOTE_TYPE, { ...data, text: "Second fix" });
  assert.equal(currentNotes(sm.getBranch()).get("findings")!.entryId, current);
  assert.deepEqual(
    (recall(sm.getBranch(), { query: "First fix" }) as { results: unknown[] }).results,
    [],
  );
  assert.match(JSON.stringify(recall(sm.getBranch(), { entryId: old })), /First fix/);
  sm.appendCustomEntry(NOTE_TYPE, { ...data, deleted: true, text: "" });
  assert.equal(currentNotes(sm.getBranch()).size, 0);
  sm.branch(old);
  assert.equal(currentNotes(sm.getBranch()).get("findings")!.entryId, old);
  sm.branch(base);
  assert.equal(currentNotes(sm.getBranch()).size, 0);
});

test("text recall excludes hidden reasoning, images bytes, !! output, and recursive tool results", () => {
  const sm = SessionManager.inMemory();
  sm.appendMessage(
    assistant([
      { type: "thinking", thinking: "PRIVATE", thinkingSignature: "SECRET" },
      { type: "text", text: "Public answer" },
    ]),
  );
  sm.appendMessage({
    role: "user",
    content: [{ type: "image", mimeType: "image/png", data: "SECRET_IMAGE" }],
    timestamp: Date.now(),
  });
  sm.appendMessage({
    role: "bashExecution",
    command: "secret",
    output: "PRIVATE_COMMAND",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext: true,
    timestamp: Date.now(),
  });
  receipt(sm);
  const text = JSON.stringify(sm.getBranch().map(evidenceFor));
  assert.match(text, /Public answer/);
  assert.match(text, /Image: not returned/);
  assert.doesNotMatch(text, /PRIVATE|SECRET|Saved/);
});

test("recent recall materializes only needed evidence", () => {
  const sm = SessionManager.inMemory();
  for (let i = 0; i < 100; i++) user(sm, `needle ${i}`);
  let reads = 0;
  const branch = sm.getBranch().map((entry) => {
    if (entry.type !== "message") return entry;
    const message = entry.message;
    return {
      ...entry,
      get message() {
        reads++;
        return message;
      },
    };
  });
  recall(branch, { limit: 2 });
  assert.ok(reads < 20, `recent recall inspected ${reads} message fields`);
  reads = 0;
  recall(branch, { query: "needle", limit: 2 });
  assert.ok(reads < 20, `search inspected ${reads} message fields`);
});

test("retrieval output is bounded even for a huge recorded tool output", () => {
  const sm = SessionManager.inMemory();
  for (let i = 0; i < 30; i++) user(sm, "needle " + "x".repeat(100_000));
  const searched = JSON.stringify(recall(sm.getBranch(), { query: "needle", limit: 20 }));
  assert.ok(searched.length < 15_000);
  assert.ok(
    JSON.stringify(recall(sm.getBranch(), { entryId: sm.getLeafId()!, limit: 12_000 })).length <
      13_000,
  );
});
