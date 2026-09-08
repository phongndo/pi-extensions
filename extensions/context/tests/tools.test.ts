import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TObject } from "typebox";
import {
  CHECKPOINT_TYPE,
  MEMORY_TOOLS,
  currentNotes,
  evidenceFor,
  latestCheckpoint,
  type CheckpointData,
} from "../model.ts";
import { withEvidenceIds } from "../provenance.ts";
import { assistant, checkpoint, harness, user } from "./helpers.ts";

test("notes actions and no-argument new_context expose strict independent schemas", async (t) => {
  const app = await harness(t);
  assert.deepEqual(new Set(app.tools.keys()), new Set(MEMORY_TOOLS));
  const notes = app.tools.get("notes")! as unknown as { parameters: TObject };
  const reset = app.tools.get("new_context")! as unknown as { parameters: TObject };
  assert.deepEqual(notes.parameters.required, ["action", "name"]);
  assert.deepEqual(Object.keys(notes.parameters.properties!), [
    "action",
    "name",
    "text",
    "revision",
    "references",
  ]);
  assert.deepEqual(Object.keys(reset.parameters.properties!), []);
  const validate = (name: string, args: Record<string, unknown>) =>
    validateToolArguments(app.tools.get(name)!, {
      type: "toolCall",
      name,
      id: "test",
      arguments: args,
    });
  validate("notes", { action: "write", name: "finding", text: "Verified" });
  validate("new_context", {});
  for (const args of [
    { action: "checkpoint", checkpoint, reset: true },
    { action: "write", name: "finding", text: "x", reset: true },
    { action: "write", name: "finding", text: "x", checkpoint },
    { action: "write", text: "missing name" },
  ])
    assert.throws(() => validate("notes", args));
  for (const args of [{ checkpoint }, { reset: true }, { ...checkpoint }, { references: [] }])
    assert.throws(() => validate("new_context", args));
});

test("new_context terminates without writing a note or checkpoint, including a sibling batch", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.execute("notes", { action: "write", name: "finding", text: "Keep this" });
  const before = currentNotes(app.sm.getBranch());
  const result = await app.newContext();
  assert.equal(result.terminate, true);
  assert.equal(latestCheckpoint(app.sm.getBranch()), undefined);
  assert.deepEqual(currentNotes(app.sm.getBranch()), before);
  await app.emit("agent_settled");
  assert.equal(app.compactions.length, 1);
  assert.equal(app.sent.length, 0);
});

test("new_context is disabled in default and each memory tool exclusion blocks rollover", async (t) => {
  const disabled = await harness(t, { initialMode: "default" });
  user(disabled.sm);
  await assert.rejects(disabled.execute("new_context", {}), /unavailable/);
  assert.ok(!disabled.controls.tools.includes("new_context"));
  await disabled.command("exp");
  assert.ok(disabled.controls.tools.includes("new_context"));
  for (const missing of MEMORY_TOOLS) {
    const app = await harness(t);
    user(app.sm);
    app.controls.tools = app.controls.tools.filter((name) => name !== missing);
    await app.command("default");
    await app.command("exp");
    assert.ok(!app.controls.tools.includes(missing));
    assert.deepEqual(await app.beforeCompact(), { cancel: true });
    assert.equal(await app.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  }
});

test("memory tools and legacy checkpoint omit recursive calls, receipts and evidence markers", () => {
  const sm = SessionManager.inMemory();
  for (const name of [...MEMORY_TOOLS, "checkpoint"]) {
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

test("legacy checkpoints remain readable after reopen but are not rollover prerequisites", async (t) => {
  const app = await harness(t);
  const request = user(app.sm);
  const coveredThrough = app.sm.appendMessage(
    assistant([
      {
        type: "toolCall",
        id: "legacy",
        name: "notes",
        arguments: { action: "checkpoint", checkpoint },
      },
    ]),
  );
  const data: CheckpointData = {
    version: 1,
    checkpoint,
    references: [request],
    coveredThrough,
    toolCallId: "legacy",
  };
  const entryId = app.sm.appendCustomEntry(CHECKPOINT_TYPE, data);
  const reopened = SessionManager.open(app.sm.getSessionFile()!);
  assert.deepEqual(latestCheckpoint(reopened.getBranch()), { entryId, data });
  const resumed = await harness(t, {}, reopened);
  assert.match(JSON.stringify(await resumed.execute("recall", { entryId })), /First fix failed/);
  const result = await resumed.beforeCompact();
  assert.ok(result?.compaction);
  assert.match(result.compaction.summary, new RegExp(entryId));
  assert.doesNotMatch(result.compaction.summary, /First fix failed/);
});
