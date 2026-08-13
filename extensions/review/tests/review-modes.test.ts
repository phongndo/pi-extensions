import assert from "node:assert/strict";
import test from "node:test";
import { REVIEW_MODES } from "../models.ts";
import {
  buildFindingVerificationPrompt,
  buildReviewerPrompt,
  FINDING_VERIFIER_SYSTEM_PROMPT,
  FIXER_SYSTEM_PROMPT,
  reviewerPathInventoryByteBudget,
  ReviewPromptBudgetError,
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

test("builds an independent candidate-verification prompt without panel provenance", () => {
  const prompt = buildFindingVerificationPrompt({
    target: {
      type: "uncommitted",
      repositoryRoot: "/repo",
      originalHead: "a".repeat(40),
      originalBranch: "main",
      baseSha: "a".repeat(40),
    },
    fingerprint: "fingerprint",
    pass: 1,
    changedFiles: ["src/example.ts"],
    findings: [
      {
        id: "RL-123",
        fingerprint: "finding-fingerprint",
        pass: 1,
        priority: "P2",
        title: "Wrong result",
        path: "src/example.ts",
        startLine: 4,
        endLine: 4,
        impact: "Returns the wrong result.",
        evidence: "The changed operand has the opposite sign.",
        suggestedFix: "Use the expected operand.",
        reportedBy: ["adversarial", "adversarial-2"],
      },
    ],
  });

  assert.match(FINDING_VERIFIER_SYSTEM_PROMPT, /confirmed only when/i);
  assert.match(FINDING_VERIFIER_SYSTEM_PROMPT, /rejected only when/i);
  assert.match(prompt, /BEGIN_UNTRUSTED_FINDING_CANDIDATES_JSON/);
  assert.match(prompt, /RL-123/);
  assert.match(prompt, /src\/example\.ts/);
  assert.doesNotMatch(prompt, /reportedBy|adversarial-2|Use the expected operand/);
});

test("fails fast when the complete path inventory cannot fit review prompts", () => {
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

  assert.throws(
    () =>
      buildFindingVerificationPrompt(
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
          changedFiles,
          findings: [
            {
              id: "RL-123",
              fingerprint: "finding-fingerprint",
              pass: 1,
              priority: "P2",
              title: "Wrong result",
              path: changedFiles[0]!,
              startLine: 1,
              endLine: 1,
              impact: "Returns the wrong result.",
              evidence: "The changed operand has the opposite sign.",
              suggestedFix: "Use the expected operand.",
              reportedBy: ["general"],
            },
          ],
        },
        128,
      ),
    (error: unknown) =>
      error instanceof ReviewPromptBudgetError &&
      /path inventory exceeds.*2\/200 paths fit/i.test(error.message),
  );

  assert.equal(reviewerPathInventoryByteBudget(8_000), 2_000);
  assert.equal(reviewerPathInventoryByteBudget(1_000_000), 64 * 1_024);
  assert.throws(() => reviewerPathInventoryByteBudget(0), /positive number/);
});
