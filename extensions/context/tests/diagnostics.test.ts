import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EVENT_TYPE, diagnostics, diagnosticStatus, pendingDiagnostics } from "../diagnostics.ts";
import { assistant } from "./helpers.ts";

function fixture() {
  const sm = SessionManager.inMemory();
  const root = sm.appendMessage({ role: "user", content: "Task", timestamp: 0 });
  const id = sm.appendCompaction("Summary", root, 100);
  const append = (data: object) =>
    sm.appendCustomEntry(EVENT_TYPE, { version: 1, implementation: "0.6.0", ...data });
  append({
    event: "compaction",
    compactionId: id,
    outcome: "fresh",
    tokensBefore: 100,
    mode: "exp",
  });
  return { sm, id, append };
}

test("malformed diagnostic measurements never consume pending usage", () => {
  for (const event of ["post_compaction_usage", "post_reset_usage"]) {
    for (const inputTokens of [undefined, null, "123", -1, NaN, Infinity, 1.5]) {
      const { sm, id, append } = fixture();
      append({ event, compactionId: id, inputTokens });
      assert.equal(diagnostics(sm.getBranch()).length, 1);
      assert.equal(diagnosticStatus(sm.getBranch()), "Last compaction: fresh.");
      sm.appendMessage(assistant([], 123));
      assert.deepEqual(
        pendingDiagnostics(sm.getBranch()),
        [{ event: "post_compaction_usage", compactionId: id, inputTokens: 123 }],
        `${event}: ${String(inputTokens)}`,
      );
    }
  }
});

test("valid legacy and current measurements remain readable without copying unknown fields", () => {
  for (const event of ["post_reset_usage", "post_compaction_usage"]) {
    const { sm, id, append } = fixture();
    append({ event, compactionId: id, inputTokens: 0, rawError: "SECRET" });
    sm.appendMessage(assistant([], 123));
    assert.deepEqual(pendingDiagnostics(sm.getBranch()), []);
    assert.match(diagnosticStatus(sm.getBranch()), /fresh; next successful request input 0 tokens/);
    assert.doesNotMatch(JSON.stringify(diagnostics(sm.getBranch())), /SECRET|rawError/);
  }
});

test("invalid diagnostic records cannot replace the last valid compaction", () => {
  const { sm, append } = fixture();
  for (const data of [
    { event: "compaction", outcome: "normal" },
    { event: "compaction", compactionId: "x", outcome: {} },
    { event: "compaction", compactionId: "x", outcome: "normal", tokensBefore: -1 },
    { event: "post_compaction_usage", inputTokens: 10 },
    { event: "unknown_event" },
    { event: "compaction", version: 99 },
  ])
    append(data);
  for (const data of [null, [], "bad", 4]) sm.appendCustomEntry(EVENT_TYPE, data);
  assert.equal(diagnostics(sm.getBranch()).length, 1);
  assert.equal(diagnosticStatus(sm.getBranch()), "Last compaction: fresh.");
});
