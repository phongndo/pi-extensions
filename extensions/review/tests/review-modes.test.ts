import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_MODES } from "../models.ts";
import {
  buildReviewerPrompt,
  FIXER_SYSTEM_PROMPT,
  reviewerPathInventoryByteBudget,
} from "../prompts.ts";
import { reviewerCountForMode, reviewerProfilesForMode } from "../review-modes.ts";

test("defines mode defaults and expands them to a configurable panel size", () => {
  assert.equal(reviewerCountForMode("standard"), 1);
  assert.equal(reviewerCountForMode("adversarial"), 2);
  for (const mode of REVIEW_MODES.filter((value) => value !== "standard")) {
    const profiles = reviewerProfilesForMode(mode);
    assert.equal(profiles.length, 2);
    assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length);
    assert.ok(profiles.every((profile) => profile.instructions.length > 40));
  }

  const expanded = reviewerProfilesForMode("adversarial", 4);
  assert.equal(expanded.length, 4);
  assert.equal(new Set(expanded.map((profile) => profile.id)).size, 4);
  assert.deepEqual(
    expanded.map((profile) => profile.id),
    ["adversarial", "adversarial-2", "adversarial-3", "adversarial-4"],
  );

  const combined = reviewerProfilesForMode("adversarial", 1)[0]!;
  assert.equal(combined.id, "adversarial");
  assert.match(combined.instructions, /concrete way it fails/);
  assert.match(combined.instructions, /none of the author's reasoning/);
  assert.throws(() => reviewerProfilesForMode("standard", 0), /positive integer/);
});

test("fixer guidance rejects symptom-level patches", () => {
  assert.match(FIXER_SYSTEM_PROMPT, /underlying violated invariant/i);
  assert.match(FIXER_SYSTEM_PROMPT, /symptom-level workaround/i);
});

test("puts mode and blind panel assignment into each reviewer prompt", () => {
  const reviewer = reviewerProfilesForMode("adversarial")[0]!;
  const prompt = buildReviewerPrompt({
    target: {
      type: "uncommitted",
      repositoryRoot: "/repo",
      originalHead: "a".repeat(40),
      originalBranch: "main",
      baseSha: "a".repeat(40),
    },
    fingerprint: "fingerprint",
    pass: 1,
    reviewMode: "adversarial",
    reviewer,
    changedFiles: ["src/example.ts", "new-file.ts"],
  });

  assert.match(prompt, /Review mode: adversarial/);
  assert.match(prompt, new RegExp(reviewer.label));
  assert.match(prompt, /cannot see other reviewers' findings/i);
  assert.match(prompt, /concrete way it fails/i);
  assert.match(prompt, /trust only the diff/i);
  assert.match(prompt, /BEGIN_UNTRUSTED_REVIEW_METADATA_JSON/);
  assert.match(prompt, /src\/example\.ts/);
  assert.match(prompt, /git -c core\.quotePath=false diff/);
  assert.match(prompt, /directly read any inventory path absent from the tracked diff/i);
});

test("fails fast when the complete path inventory cannot fit the reviewer prompt", () => {
  const reviewer = reviewerProfilesForMode("standard")[0]!;
  const suffix = "x".repeat(40);
  const changedFiles = Array.from(
    { length: 200 },
    (_value, index) => `src/generated-${index.toString().padStart(3, "0")}-${suffix}.ts`,
  );
  assert.throws(
    () =>
      buildReviewerPrompt(
        {
          target: {
            type: "uncommitted",
            repositoryRoot: "/repo",
            originalHead: "a".repeat(40),
            originalBranch: "main",
            baseSha: "a".repeat(40),
            initialUntrackedPaths: changedFiles,
          },
          fingerprint: "fingerprint",
          pass: 1,
          reviewMode: "standard",
          reviewer,
          changedFiles,
        },
        128,
      ),
    /path inventory exceeds.*2\/200 paths fit/i,
  );

  assert.equal(reviewerPathInventoryByteBudget(8_000), 2_000);
  assert.equal(reviewerPathInventoryByteBudget(1_000_000), 64 * 1_024);
  assert.throws(() => reviewerPathInventoryByteBudget(0), /positive number/);
});
