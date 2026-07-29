import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FindingLedgerEntry, ReviewTargetSnapshot } from "../models.ts";
import { buildFixerPrompt } from "../prompts.ts";
import {
  fixerFindingsByteBudget,
  fixerInputByteBudget,
  validateFixSubmission,
  validateReviewSubmission,
} from "../protocol.ts";
import { ReviewerProtocolError, validateReviewerResult } from "../reviewer.ts";

async function fixture(): Promise<{ root: string; target: ReviewTargetSnapshot }> {
  const root = await mkdtemp(join(tmpdir(), "review-loop-protocol-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
  await writeFile(join(root, "@config.ts"), "config\n", "utf8");
  return {
    root,
    target: {
      type: "uncommitted",
      repositoryRoot: root,
      originalHead: "a".repeat(40),
      originalBranch: "main",
      baseSha: "a".repeat(40),
    },
  };
}

function finding(path = "src/a.ts", startLine = 2) {
  return {
    priority: "P2" as const,
    title: "Incorrect result",
    path,
    startLine,
    endLine: startLine,
    impact: "Returns an incorrect value.",
    evidence: "The changed expression uses the wrong operand.",
    suggestedFix: "Use the expected operand.",
  };
}

test("validates, IDs, and deduplicates review findings", async () => {
  const { target } = await fixture();
  const result = await validateReviewSubmission(
    {
      verdict: "findings",
      findings: [finding(), finding()],
      humanCallouts: [],
    },
    { target, pass: 1, changedLines: { "src/a.ts": new Set([2]) } },
  );
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0]!.id, /^RL-[a-f0-9]{12}$/);
  assert.equal(result.findings[0]!.pass, 1);
});

test("retains same-title findings at distinct locations with shared context", async () => {
  const { target } = await fixture();
  const result = await validateReviewSubmission(
    {
      verdict: "findings",
      findings: [finding("src/a.ts", 1), finding("src/a.ts", 2)],
      humanCallouts: [],
    },
    { target, pass: 1, changedLines: { "src/a.ts": new Set([1, 2]) } },
  );
  assert.equal(result.findings.length, 2);
  assert.notEqual(result.findings[0]?.fingerprint, result.findings[1]?.fingerprint);
});

test("preserves literal finding paths beginning with @", async () => {
  const { target } = await fixture();
  const result = await validateReviewSubmission(
    { verdict: "findings", findings: [finding("@config.ts", 1)], humanCallouts: [] },
    { target, pass: 1, changedLines: { "@config.ts": new Set([1]) } },
  );
  assert.equal(result.findings[0]?.path, "@config.ts");
});

test("finding context reads honor cancellation", async () => {
  const { target } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding()], humanCallouts: [] },
      {
        target,
        pass: 1,
        changedLines: { "src/a.ts": new Set([2]) },
        signal: controller.signal,
      },
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("enforces path safety while accepting broken and escaping folder symlinks", async () => {
  const { root, target } = await fixture();
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "clean", findings: [finding()], humanCallouts: [] },
      { target, pass: 1, changedLines: { "src/a.ts": new Set([2]) } },
    ),
    /clean review/,
  );
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding("src/a.ts", 3)], humanCallouts: [] },
      { target, pass: 1, changedLines: { "src/a.ts": new Set([2]) } },
    ),
    /does not overlap/,
  );
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding("../outside.ts")], humanCallouts: [] },
      { target, pass: 1, changedLines: { "../outside.ts": new Set([2]) } },
    ),
    /escapes the repository/,
  );
  const folderTarget: ReviewTargetSnapshot = {
    type: "folder",
    repositoryRoot: root,
    originalHead: "a".repeat(40),
    originalBranch: "main",
    paths: ["docs"],
  };
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding()], humanCallouts: [] },
      { target: folderTarget, pass: 1 },
    ),
    /outside the selected folder scope/,
  );

  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding("src/invented.ts", 1)], humanCallouts: [] },
      { target: { ...folderTarget, paths: ["src"] }, pass: 1 },
    ),
    /does not exist/,
  );
  await assert.rejects(
    validateReviewSubmission(
      { verdict: "findings", findings: [finding("src", 1)], humanCallouts: [] },
      { target: { ...folderTarget, paths: ["src"] }, pass: 1 },
    ),
    /regular file/,
  );

  const outside = await mkdtemp(join(tmpdir(), "review-loop-folder-symlink-"));
  await writeFile(join(outside, "outside.ts"), "outside\n", "utf8");
  await symlink(join(outside, "outside.ts"), join(root, "src", "external.ts"));
  await symlink("missing.ts", join(root, "src", "broken.ts"));
  const symlinkFindings = await validateReviewSubmission(
    {
      verdict: "findings",
      findings: [
        { ...finding("src/external.ts", 1), title: "Escaping symlink" },
        { ...finding("src/broken.ts", 1), title: "Broken symlink" },
      ],
      humanCallouts: [],
    },
    { target: { ...folderTarget, paths: ["src"] }, pass: 1 },
  );
  assert.equal(symlinkFindings.findings.length, 2);
});

test("rejects folder findings in Git metadata and symlink aliases", async () => {
  const { root } = await fixture();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "secret\n");
  await symlink(".git", join(root, "metadata"));
  await symlink(".git/config", join(root, "config-alias"));
  await symlink("metadata/missing", join(root, "missing-config-alias"));
  const target: ReviewTargetSnapshot = {
    type: "folder",
    repositoryRoot: root,
    originalHead: "a".repeat(40),
    originalBranch: "main",
    paths: ["."],
  };

  for (const path of [".git/config", "metadata/config", "config-alias", "missing-config-alias"]) {
    await assert.rejects(
      validateReviewSubmission(
        { verdict: "findings", findings: [finding(path, 1)], humanCallouts: [] },
        { target, pass: 1 },
      ),
      /Git metadata/,
    );
  }
});

test("accepts changed broken/external symlinks and gitlink-like entries lexically", async () => {
  const { root, target } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "review-loop-protocol-outside-"));
  await writeFile(join(outside, "target.ts"), "outside\n");
  await symlink("missing-target.ts", join(root, "src", "broken.ts"));
  await symlink(join(outside, "target.ts"), join(root, "src", "external.ts"));
  await mkdir(join(root, "src", "submodule"));

  const result = await validateReviewSubmission(
    {
      verdict: "findings",
      findings: [
        { ...finding("src/broken.ts", 1), title: "Broken symlink" },
        { ...finding("src/external.ts", 1), title: "Escaping symlink" },
        { ...finding("src/submodule", 1), title: "Incorrect gitlink" },
      ],
      humanCallouts: [],
    },
    {
      target,
      pass: 1,
      changedLines: {
        "src/broken.ts": new Set([1]),
        "src/external.ts": new Set([1]),
        "src/submodule": new Set([1]),
      },
    },
  );
  assert.equal(result.findings.length, 3);
});

test("preserves non-Latin distinctions in finding fingerprints", async () => {
  const { target } = await fixture();
  const result = await validateReviewSubmission(
    {
      verdict: "findings",
      findings: [
        { ...finding(), title: "错误甲" },
        { ...finding(), title: "错误乙" },
      ],
      humanCallouts: [],
    },
    { target, pass: 1, changedLines: { "src/a.ts": new Set([2]) } },
  );
  assert.equal(result.findings.length, 2);
  assert.notEqual(result.findings[0]?.fingerprint, result.findings[1]?.fingerprint);
});

test("classifies every reviewer submission validation failure as a protocol error", async () => {
  const { target } = await fixture();
  await assert.rejects(
    validateReviewerResult(
      { verdict: "findings", findings: [finding(".")], humanCallouts: [] },
      { target, pass: 1, changedLines: { ".": new Set([2]) } },
    ),
    (error: unknown) =>
      error instanceof ReviewerProtocolError && /must identify a file/.test(error.message),
  );
});

test("rejects reviewer findings that exceed the aggregate fixer budget", async () => {
  const { target } = await fixture();
  await assert.rejects(
    validateReviewSubmission(
      {
        verdict: "findings",
        findings: [{ ...finding(), impact: "x".repeat(2_000) }],
        humanCallouts: [],
      },
      {
        target,
        pass: 1,
        changedLines: { "src/a.ts": new Set([2]) },
        maxFindingsBytes: fixerFindingsByteBudget(1_000),
      },
    ),
    /aggregate fixer-input budget/,
  );
});

test("bounds optional host context in fixer prompts without dropping current finding IDs", async () => {
  const { target } = await fixture();
  const reviewed = await validateReviewSubmission(
    { verdict: "findings", findings: [finding()], humanCallouts: [] },
    { target, pass: 1, changedLines: { "src/a.ts": new Set([2]) } },
  );
  const ledger: FindingLedgerEntry[] = Array.from({ length: 40 }, (_, index) => ({
    findingId: `RL-old-${index}`,
    fingerprint: `${index}`.padStart(64, "0"),
    priority: "P2",
    title: "Old finding",
    path: "src/a.ts",
    pass: 1,
    status: "queued",
    explanation: "x".repeat(4_000),
  }));
  const maximumBytes = fixerInputByteBudget(2_000);
  const prompt = buildFixerPrompt(
    {
      target,
      findings: reviewed.findings,
      ledger,
      pass: 1,
      verificationFailure: {
        configured: true,
        command: "test",
        passed: false,
        output: `${"failure\n".repeat(4_000)}FINAL_UNIQUE_ERROR\n`,
      },
    },
    maximumBytes,
  );
  assert.ok(Buffer.byteLength(prompt, "utf8") <= maximumBytes);
  assert.match(prompt, new RegExp(reviewed.findings[0]!.id));
  assert.match(prompt, /omitted to fit the fixer context/);
  assert.match(prompt, /FINAL_UNIQUE_ERROR/);
});

test("validates complete fixer outcomes", () => {
  const result = validateFixSubmission(
    {
      status: "fixed",
      outcomes: [{ findingId: "RL-1", status: "fixed", explanation: "Corrected it." }],
      checksRun: [{ command: "pnpm test", exitCode: 0 }],
      summary: "Fixed.",
    },
    ["RL-1"],
  );
  assert.equal(result.status, "fixed");
  assert.throws(
    () =>
      validateFixSubmission({ status: "fixed", outcomes: [], checksRun: [], summary: "Done" }, [
        "RL-1",
      ]),
    /omitted/,
  );
  assert.throws(
    () =>
      validateFixSubmission(
        {
          status: "fixed",
          outcomes: [{ findingId: "other", status: "fixed", explanation: "Done" }],
          checksRun: [],
          summary: "Done",
        },
        ["RL-1"],
      ),
    /Unknown finding/,
  );
});
