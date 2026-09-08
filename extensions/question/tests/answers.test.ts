import assert from "node:assert/strict";
import test from "node:test";
import { choiceAnswer, MAX_CUSTOM_ANSWER_LENGTH, OTHER_CHOICE } from "../answers.ts";

const options = [{ label: "First" }, { label: "Second" }];

test("submission shares option ordering, deduplication and empty-answer policy", () => {
  assert.deepEqual(choiceAnswer(options, new Set(["Second", "First", "unknown"])), [
    "First",
    "Second",
  ]);
  assert.equal(choiceAnswer(options, new Set(["unknown"])), undefined);
  assert.deepEqual(choiceAnswer(options, new Set(["First"]), { kind: "answer", text: " First " }), [
    "First",
  ]);
});

test("notes and RPC custom answers preserve their existing wire semantics", () => {
  for (const kind of ["note", "answer"] as const) {
    const value = kind === "note" ? "user_note: custom" : "custom";
    assert.deepEqual(choiceAnswer(options, new Set([OTHER_CHOICE]), { kind, text: " custom " }), [
      value,
    ]);
    assert.deepEqual(
      choiceAnswer(options, new Set(["Second", OTHER_CHOICE]), { kind, text: "custom" }),
      ["Second", value],
    );
  }
  assert.deepEqual(choiceAnswer(options, new Set([OTHER_CHOICE])), [OTHER_CHOICE]);
  assert.deepEqual(choiceAnswer(options, new Set([OTHER_CHOICE]), { kind: "note", text: "  " }), [
    OTHER_CHOICE,
  ]);
});

test("submission bounds custom input without truncating user intent", () => {
  assert.throws(
    () =>
      choiceAnswer(options, new Set(), {
        kind: "answer",
        text: "x".repeat(MAX_CUSTOM_ANSWER_LENGTH + 1),
      }),
    /under/,
  );
  assert.equal(
    choiceAnswer(options, new Set(), {
      kind: "note",
      text: "x".repeat(MAX_CUSTOM_ANSWER_LENGTH),
    })?.[0].length,
    MAX_CUSTOM_ANSWER_LENGTH + "user_note: ".length,
  );
});
