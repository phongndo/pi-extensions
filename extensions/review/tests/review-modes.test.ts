import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_MODES } from "../models.ts";
import { buildReviewerPrompt, FIXER_SYSTEM_PROMPT } from "../prompts.ts";
import { reviewerCountForMode, reviewerProfilesForMode } from "../review-modes.ts";

test("defines mode defaults and expands them to a configurable panel size", () => {
  assert.equal(reviewerCountForMode("standard"), 1);
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
    ["root-cause", "system-design", "root-cause-2", "system-design-2"],
  );

  const combined = reviewerProfilesForMode("security", 1)[0]!;
  assert.equal(combined.id, "security");
  assert.match(combined.instructions, /authentication/);
  assert.match(combined.instructions, /denial of service/);
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
  });

  assert.match(prompt, /Review mode: adversarial/);
  assert.match(prompt, new RegExp(reviewer.label));
  assert.match(prompt, /cannot see other reviewers' findings/i);
  assert.match(prompt, /root cause/i);
  assert.match(prompt, /symptom/i);
});
