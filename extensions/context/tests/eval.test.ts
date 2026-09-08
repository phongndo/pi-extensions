import assert from "node:assert/strict";
import test from "node:test";
import { scoreAnswer } from "../evals/score.ts";

test("evaluation scoring ignores Markdown but preserves exact identifiers and values", () => {
  const patterns = [
    /partial transaction/i,
    /expected\s*[=:]?\s*3/i,
    /retry_boundary\.spec\.ts::preserves_outer_transaction/,
  ];
  assert.deepEqual(
    scoreAnswer(
      patterns,
      "**partial** transaction; **Expected:** 3; `retry_boundary.spec.ts::preserves_outer_transaction`",
    ),
    [true, true, true],
  );
  assert.deepEqual(scoreAnswer(patterns, "whole transaction; Expected: 4; retry_other.spec.ts"), [
    false,
    false,
    false,
  ]);
});
