import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GUIDE, RECALL_DESCRIPTION } from "../guidance.ts";
import { NOTE_TYPE, evidenceFor, recall, type RecallInput } from "../model.ts";
import { withEvidenceIds } from "../provenance.ts";
import { assistant, harness, user } from "./helpers.ts";

type Page = {
  results: { entryId: string; snippet: string }[];
  notes?: { name: string; entryId: string }[];
  nextCursor: string | null;
};
const page = (sm: SessionManager, input: RecallInput): Page =>
  recall(sm.getBranch(), input) as Page;

function fullRead(sm: SessionManager, entryId: string): string {
  let result = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk = recall(sm.getBranch(), { entryId, offset, limit: 997 }) as {
      text: string;
      nextOffset: number | null;
    };
    result += chunk.text;
    offset = chunk.nextOffset;
  }
  return result;
}

test("lean search omits repeated index without losing discovery, note revisions or pagination", () => {
  const sm = SessionManager.inMemory();
  const evidence = user(sm, "needle: preserve exact expected=3 actual=4");
  const ids = Array.from({ length: 64 }, (_, i) =>
    sm.appendCustomEntry(NOTE_TYPE, {
      version: 1,
      name: `finding-${i}`,
      text: `needle detail ${i}`,
      references: [evidence],
      deleted: false,
    }),
  );
  const before = JSON.stringify(sm.getEntries());
  const discovered = page(sm, { limit: 1 });
  assert.equal(discovered.notes!.length, 64);
  assert.equal(page(sm, { source: "notes", limit: 1 }).notes!.length, 64);
  assert.equal(page(sm, { cursor: discovered.nextCursor! }).notes, undefined);
  const targeted = page(sm, { query: "expected", role: "user", source: "original" });
  assert.equal(targeted.notes, undefined);
  assert.equal(targeted.results[0]!.entryId, evidence);
  // The index is omitted, not returned as [] (which would falsely claim there are no notes).
  assert.ok(!Object.hasOwn(targeted, "notes"));
  assert.ok(
    JSON.stringify(targeted).length <
      JSON.stringify({ ...targeted, notes: discovered.notes }).length / 3,
  );
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const result = page(sm, {
      query: "needle",
      source: "notes",
      limit: 7,
      ...(cursor ? { cursor } : {}),
    });
    assert.equal(result.notes, undefined);
    found.push(...result.results.map((entry) => entry.entryId));
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(found, [...ids].reverse());
  for (const id of ids) assert.match(fullRead(sm, id), new RegExp(evidence));
  assert.equal(JSON.stringify(sm.getEntries()), before);
});

test("recorded Unicode evidence and legacy notes remain exact after two compactions and disk reopen", async (t) => {
  const app = await harness(t);
  user(app.sm, "LATEST: /work/new, read-only, no deployment.");
  const text = "FAIL expected=3 actual=4\n" + "界🙂e\u0301\r\n".repeat(5000) + "END evidence";
  const id = app.sm.appendMessage({
    role: "toolResult",
    toolCallId: "failure",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: Date.now(),
  });
  const noteId = app.sm.appendCustomEntry(NOTE_TYPE, {
    version: 1,
    name: "failure",
    text: "Keep the exact log in linked evidence, not checkpoint prose.",
    references: [id],
    deleted: false,
  });
  app.sm.appendMessage(assistant([{ type: "text", text: "Investigation saved" }]));
  const original = JSON.stringify(app.sm.getEntry(id));
  const originalNote = evidenceFor(app.sm.getEntry(noteId)!)!.text;
  for (let i = 0; i < 2; i++) {
    assert.equal(await app.beforeCompact(), undefined);
    const compactId = app.sm.appendCompaction("Stock summary", app.sm.getLeafId()!, 90_000);
    await app.emit("session_compact", { compactionEntry: app.sm.getEntry(compactId) });
    assert.doesNotMatch(JSON.stringify(app.sm.buildSessionContext().messages), /END evidence/);
    assert.equal(fullRead(app.sm, id), text);
    app.sm.appendMessage(
      assistant([{ type: "text", text: "Continued without repeating completed work." }]),
    );
  }
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  assert.equal(JSON.stringify(reopened.getEntry(id)), original);
  assert.deepEqual(Buffer.from(fullRead(reopened, id)), Buffer.from(text));
  assert.equal(fullRead(reopened, noteId), originalNote);
  assert.equal(
    page(reopened, { source: "notes" }).notes!.find((note) => note.name === "failure")!.entryId,
    noteId,
  );
});

test("recall guidance stays bounded and distinguishes historical evidence from authorization", () => {
  const always = GUIDE + RECALL_DESCRIPTION;
  assert.ok(always.length <= 1300, "review any permanent prompt expansion");
  for (const phrase of [
    "never authorization",
    "latest permissions",
    "missing, ambiguous or conflicting",
    "Do not reread evidence already available",
    "Pi compacts normally",
  ])
    assert.ok(always.includes(phrase), phrase);
  assert.doesNotMatch(always, /new_context|save.*note|rollover|quota/);
  const sm = SessionManager.inMemory();
  const id = user(sm, "Do not deploy");
  const messages = sm.buildSessionContext().messages;
  const marked = withEvidenceIds(messages, sm.getBranch());
  const message = marked[0]!;
  assert.ok(message.role === "user" && Array.isArray(message.content));
  assert.deepEqual(message.content.at(-1), { type: "text", text: `[evidence:${id}]` });
  assert.equal(`[evidence:${id}]`.length, 19);
  assert.equal(JSON.stringify(sm.getEntries()).includes("[evidence:"), false);
});
