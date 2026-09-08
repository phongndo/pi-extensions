import assert from "node:assert/strict";
import test from "node:test";
import { windowBootstrap, currentNotes, recall } from "../model.ts";
import { harness, user } from "./helpers.ts";

test("recovery pointers retain access to uncertainty and latest permissions without copying payloads", async (t) => {
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
    text: "Verified: exact failure in linked log. Attempted: draft, not applied. Assumed: savepoint duplicates commit; validate.",
    references: [toolId],
  });
  const noteId = currentNotes(app.sm.getBranch()).get("failure")!.entryId;
  const latest = user(app.sm, "LATEST: /work/new, read-only; propose a diff only. No deployment.");
  const source = app.sm.getEntry(toolId)!;
  if (source.type !== "message" || source.message.role !== "toolResult")
    throw new Error("expected source");
  const content = source.message.content;
  let payloadReads = 0;
  Object.defineProperty(source.message, "content", {
    enumerable: true,
    get() {
      payloadReads++;
      return content;
    },
  });
  const boot = windowBootstrap(app.sm.getBranch());
  assert.equal(payloadReads, 0);
  for (const id of [initial, latest, noteId]) assert.ok(boot.includes(id));
  assert.doesNotMatch(boot, /Large original diagnostic payload|savepoint|\/work\/new/);
  assert.equal(
    (recall(app.sm.getBranch(), { entryId: toolId, limit: 12000 }) as { text: string }).text,
    output.slice(0, 12000),
  );
  assert.match(JSON.stringify(recall(app.sm.getBranch(), { entryId: latest })), /read-only/);
  assert.match(
    JSON.stringify(recall(app.sm.getBranch(), { entryId: noteId })),
    /not applied|Assumed/,
  );
});

test("uncertain findings are optional and require neither invented sources nor a handoff", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.execute("notes", {
    action: "write",
    name: "hypothesis",
    text: "Assumed: timeout may be at the outer boundary. No test run yet; validate next.",
  });
  assert.deepEqual(currentNotes(app.sm.getBranch()).get("hypothesis")!.data.references, []);
  await app.newContext();
  assert.ok((await app.beforeCompact())?.compaction);
});
