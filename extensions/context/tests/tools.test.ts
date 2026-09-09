import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import { CHECKPOINT_TYPE, NOTE_TYPE, evidenceFor, recall } from "../model.ts";
import { withEvidenceIds } from "../provenance.ts";
import { assistant, checkpoint, harness, user } from "./helpers.ts";

test("only recall is registered with a strict read-only schema", async (t) => {
  const app = await harness(t);
  assert.deepEqual([...app.tools.keys()], ["recall"]);
  const tool = app.tools.get("recall")!;
  const schema = tool.parameters as TObject & { additionalProperties: boolean };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties!), [
    "query",
    "entryId",
    "offset",
    "limit",
    "cursor",
    "role",
    "toolName",
    "source",
    "window",
  ]);
  const validate = (args: Record<string, unknown>) =>
    validateToolArguments(tool, {
      type: "toolCall",
      name: "recall",
      id: "test",
      arguments: args,
    });
  validate({});
  validate({ query: "failure", role: "user", source: "original", window: "previous" });
  for (const args of [
    { action: "write", name: "finding" },
    { reset: true },
    { query: "" },
    { offset: -1 },
    { role: "system" },
    { source: "bogus" },
    { limit: 12001 },
  ])
    assert.throws(() => validate(args));
});

test("current and retired memory tools omit recursive calls, receipts and evidence markers", () => {
  const sm = SessionManager.inMemory();
  for (const name of ["recall", "notes", "new_context", "checkpoint"]) {
    const call = sm.appendMessage(assistant([{ type: "toolCall", id: name, name, arguments: {} }]));
    const receipt = sm.appendMessage({
      role: "toolResult",
      toolCallId: name,
      toolName: name,
      content: [{ type: "text", text: "recursive payload" }],
      isError: false,
      timestamp: Date.now(),
    });
    assert.equal(evidenceFor(sm.getEntry(call)!), undefined);
    assert.equal(evidenceFor(sm.getEntry(receipt)!), undefined);
  }
  const messages = sm.buildSessionContext().messages;
  assert.deepEqual(withEvidenceIds(messages, sm.getBranch()), messages);
});

test("legacy notes and checkpoints remain readable after reopen; no new writes", async (t) => {
  const app = await harness(t);
  const request = user(app.sm);
  const coveredThrough = app.sm.appendMessage(
    assistant([{ type: "text", text: "Legacy findings" }]),
  );
  const checkpointId = app.sm.appendCustomEntry(CHECKPOINT_TYPE, {
    version: 1,
    checkpoint,
    references: [request],
    coveredThrough,
    toolCallId: "legacy",
  });
  const noteId = app.sm.appendCustomEntry(NOTE_TYPE, {
    version: 1,
    name: "finding",
    text: "Preserve the exact evidence",
    references: [request],
    deleted: false,
  });
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  const resumed = await harness(t, reopened);
  assert.equal(await resumed.beforeCompact(), undefined);
  const before = JSON.stringify(reopened.getEntries());
  assert.match(
    JSON.stringify(await resumed.execute("recall", { entryId: checkpointId })),
    /First fix failed/,
  );
  assert.match(
    JSON.stringify(await resumed.execute("recall", { entryId: noteId })),
    /exact evidence/,
  );
  assert.match(JSON.stringify(await resumed.execute("recall", { source: "notes" })), /finding/);
  const corrupt = reopened.appendCustomEntry(CHECKPOINT_TYPE, { version: 99 });
  assert.throws(() => recall(reopened.getBranch(), { entryId: corrupt }), /unavailable/);
  assert.equal(JSON.stringify(reopened.getEntries().slice(0, -1)), before);
});
