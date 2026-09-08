import assert from "node:assert/strict";
import test from "node:test";
import { bootstrap, latestCheckpoint, currentNotes, recall } from "../model.ts";
import { harness, receipt, toolCall, user } from "./helpers.ts";

test("handoffs retain uncertainty, latest permissions and typed source pointers without copying payloads", async (t) => {
  const app = await harness(t);
  const initial = user(app.sm, "Implement retry in /work/old");
  const output =
    "FAIL retry_boundary.spec.ts::preserves_outer_transaction expected=3 actual=4\n" +
    "Large original diagnostic payload. ".repeat(1000);
  const toolId = app.sm.appendMessage({
    role: "toolResult",
    toolCallId: "test",
    toolName: "bash",
    content: [{ type: "text", text: output }],
    isError: true,
    timestamp: Date.now(),
  });
  await app.execute("notes", {
    action: "write",
    name: "failure",
    text: "Verified: exact failure is in the linked original log. Attempted: drafted patch, not applied. Assumed: savepoint causes duplicate commit; validate before claiming a fix.",
    references: [toolId],
  });
  const noteId = currentNotes(app.sm.getBranch()).get("failure")!.entryId;
  const latest = user(app.sm, "LATEST: /work/new, read-only; propose a diff only. No deployment.");
  const checkpoint = {
    goal: "Finish the retry investigation and proposed diff",
    constraints:
      "Latest permission: /work/new, read-only, no deployment. Preserve the outer transaction.",
    progress:
      "Verified: failing test recorded. Attempted: draft only, not applied/tested. Assumed: savepoint cause remains unverified. See failure note.",
    nextSteps:
      "Propose a diff; list validation needed before declaring the fix successful. Do not rerun the completed investigation.",
  };
  toolCall(app.sm, "checkpoint");
  await app.execute(
    "notes",
    { action: "checkpoint", checkpoint, references: [initial, toolId, noteId] },
    "checkpoint",
  );
  receipt(app.sm, "checkpoint");
  const saved = latestCheckpoint(app.sm.getBranch())!;
  assert.ok(
    saved.data.references.includes(latest),
    "latest steering source is attached automatically",
  );
  const source = app.sm.getEntry(toolId)!;
  assert.equal(source.type, "message");
  if (source.type !== "message" || source.message.role !== "toolResult")
    throw new Error("expected tool source");
  const content = source.message.content;
  let payloadReads = 0;
  Object.defineProperty(source.message, "content", {
    enumerable: true,
    get() {
      payloadReads++;
      return content;
    },
  });
  const handoff = bootstrap(saved, app.sm.getBranch());
  assert.equal(payloadReads, 0, "source labels don't materialize large payloads");
  for (const value of Object.values(checkpoint)) assert.ok(handoff.includes(value));
  assert.ok(handoff.includes(`${latest} [user]`));
  assert.ok(handoff.includes(`${toolId} [tool result, error]`));
  assert.ok(handoff.includes(`${noteId} [note]`));
  assert.match(handoff, /source types, not proof/);
  assert.doesNotMatch(
    handoff,
    /Large original diagnostic payload|savepoint causes duplicate commit/,
  );
  const original = recall(app.sm.getBranch(), { entryId: toolId, limit: 12000 }) as {
    text: string;
  };
  assert.equal(original.text, output.slice(0, 12000));
  const note = recall(app.sm.getBranch(), { entryId: noteId }) as { text: string };
  assert.match(note.text, /not applied|Assumed/);
});

test("uncertain findings remain savable without invented sources or citation quotas", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.execute("notes", {
    action: "write",
    name: "hypothesis",
    text: "Assumed: timeout may be at the outer boundary. No test run yet; validate next.",
  });
  assert.deepEqual(currentNotes(app.sm.getBranch()).get("hypothesis")!.data.references, []);
  await app.saveCheckpoint();
  const result = await app.beforeCompact();
  assert.ok(result?.compaction, "structural guards don't pretend to judge claim semantics");
});
