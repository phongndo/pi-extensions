import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ResolvedModels } from "../child-session.ts";
import {
  FixerProtocolError,
  assertMutationPath,
  type FixerRunner,
  type FixerRunInput,
  type FixerRunOutput,
} from "../fixer.ts";
import type { ExecGit } from "../git.ts";
import type {
  NormalizedReviewSubmission,
  ReviewFinding,
  ReviewLoopSettings,
  ReviewTargetSnapshot,
  VerificationResult,
} from "../models.ts";
import { emptyUsage } from "../models.ts";
import { aggregateReviewerPanel, runReviewLoop } from "../orchestrator.ts";
import { reviewerProfilesForMode } from "../review-modes.ts";
import { resultContextContent } from "../renderers.ts";
import {
  ReviewerProtocolError,
  type ReviewerRunInput,
  type ReviewerRunOutput,
  type ReviewerRunner,
} from "../reviewer.ts";

const execFileAsync = promisify(execFile);

function executor(): ExecGit {
  return async (command, args, options) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        signal: options?.signal,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
        killed: false,
      };
    }
  };
}

async function fixture(): Promise<{ root: string; target: ReviewTargetSnapshot }> {
  const root = await mkdtemp(join(tmpdir(), "review-loop-orchestrator-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "a.ts"), "good\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return {
    root,
    target: {
      type: "uncommitted",
      repositoryRoot: root,
      originalHead: head,
      originalBranch: "main",
      baseSha: head,
    },
  };
}

const models = {
  fixerModel: { contextWindow: 128_000 },
  reviewer: {
    reference: { provider: "test", modelId: "reviewer" },
    thinkingLevel: "off",
    displayName: "Reviewer",
  },
  fixer: {
    reference: { provider: "test", modelId: "fixer" },
    thinkingLevel: "off",
    displayName: "Fixer",
  },
} as ResolvedModels;

function settings(overrides: Partial<ReviewLoopSettings> = {}): ReviewLoopSettings {
  return {
    version: 2,
    reviewMode: "standard",
    reviewerCount: 1,
    maximumPasses: 4,
    requiredCleanRuns: 1,
    fixP3Findings: true,
    fixerContext: "continuous",
    ...overrides,
  };
}

function clean(): NormalizedReviewSubmission {
  return { verdict: "clean", findings: [], humanCallouts: [] };
}

function finding(pass: number, priority: "P2" | "P3" = "P2"): ReviewFinding {
  return {
    id: "RL-same",
    fingerprint: "same-fingerprint",
    pass,
    priority,
    title: "Bad value",
    path: "a.ts",
    startLine: 1,
    endLine: 1,
    impact: "Incorrect behavior.",
    evidence: "The value is bad.",
    suggestedFix: "Use the good value.",
  };
}

class SequenceReviewer implements ReviewerRunner {
  index = 0;
  private readonly values: NormalizedReviewSubmission[];
  constructor(values: NormalizedReviewSubmission[]) {
    this.values = values;
  }
  async review(_input: ReviewerRunInput): Promise<ReviewerRunOutput> {
    const submission = this.values[Math.min(this.index, this.values.length - 1)]!;
    this.index += 1;
    return { submission, usage: emptyUsage(), protocolRetries: 0 };
  }
}

class FakeFixer implements FixerRunner {
  calls = 0;
  private readonly action: (input: FixerRunInput, call: number) => Promise<void> | void;
  private readonly disposeAction: () => Promise<void> | void;
  constructor(
    action: (input: FixerRunInput, call: number) => Promise<void> | void,
    disposeAction: () => Promise<void> | void = () => undefined,
  ) {
    this.action = action;
    this.disposeAction = disposeAction;
  }
  async fix(input: FixerRunInput): Promise<FixerRunOutput> {
    this.calls += 1;
    await this.action(input, this.calls);
    return {
      submission: {
        status: "fixed",
        outcomes: input.findings.map((item) => ({
          findingId: item.id,
          status: "fixed" as const,
          explanation: "Corrected.",
        })),
        checksRun: [],
        summary: "Corrected findings.",
      },
      usage: emptyUsage(),
      protocolRetries: 0,
    };
  }
  async dispose(): Promise<void> {
    await this.disposeAction();
  }
}

const noVerification = async (): Promise<VerificationResult> => ({
  configured: false,
  passed: true,
});

const billedUsage = {
  input: 11,
  output: 7,
  cacheRead: 3,
  cacheWrite: 2,
  cost: 0.25,
  turns: 1,
};

test("finishes after a fresh clean review", async () => {
  const { target } = await fixture();
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([clean()]),
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "clean");
  assert.equal(result.reviewMode, "standard");
  assert.equal(result.passes.length, 1);
  assert.equal(result.passes[0]?.reviewers.length, 1);
});

test(
  "runs the configured number of adversarial reviewers concurrently on one fingerprint",
  { timeout: 5_000 },
  async () => {
    const { target } = await fixture();
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let releasePanel!: () => void;
    const panelStarted = new Promise<void>((resolvePromise) => {
      releasePanel = resolvePromise;
    });
    const reviewerIds: string[] = [];
    const fingerprints = new Set<string>();
    const passCaches = new Set<NonNullable<ReviewerRunInput["passCache"]>>();
    const reviewer: ReviewerRunner = {
      async review(input): Promise<ReviewerRunOutput> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started += 1;
        reviewerIds.push(input.reviewer.id);
        fingerprints.add(input.fingerprint);
        assert.ok(input.passCache);
        passCaches.add(input.passCache);
        if (started === 4) releasePanel();
        await new Promise<void>((resolvePromise, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Only ${started} panel reviewer(s) started.`)),
            1_000,
          );
          void panelStarted.then(() => {
            clearTimeout(timer);
            resolvePromise();
          }, reject);
        });
        active -= 1;
        return { submission: clean(), usage: emptyUsage(), protocolRetries: 0 };
      },
    };

    const result = await runReviewLoop({
      target,
      settings: settings({ reviewMode: "adversarial", reviewerCount: 4 }),
      models,
      reviewer,
      createFixer: () => new FakeFixer(() => undefined),
      host: { execute: executor(), verify: noVerification },
    });

    assert.equal(result.status, "clean");
    assert.equal(maximumActive, 4);
    assert.equal(fingerprints.size, 1);
    assert.equal(passCaches.size, 1);
    assert.deepEqual(reviewerIds.sort(), [
      "adversarial",
      "adversarial-2",
      "adversarial-3",
      "adversarial-4",
    ]);
    assert.equal(result.passes[0]?.reviewers.length, 4);
  },
);

test("aggregates duplicate panel findings and preserves reviewer provenance", () => {
  const profiles = reviewerProfilesForMode("adversarial");
  const shared = finding(1);
  const result = aggregateReviewerPanel([
    {
      profile: profiles[0]!,
      submission: { verdict: "findings", findings: [shared], humanCallouts: [] },
    },
    {
      profile: profiles[1]!,
      submission: {
        verdict: "findings",
        findings: [{ ...shared, evidence: "Independent evidence." }],
        humanCallouts: [],
      },
    },
  ]);

  assert.equal(result.submission.findings.length, 1);
  assert.deepEqual(result.submission.findings[0]?.reportedBy, ["adversarial", "adversarial-2"]);
  assert.equal(result.reviewers.length, 2);

  const callouts = aggregateReviewerPanel([
    {
      profile: profiles[0]!,
      submission: {
        ...clean(),
        humanCallouts: Array.from({ length: 30 }, (_value, index) => `first-${index}`),
      },
    },
    {
      profile: profiles[1]!,
      submission: {
        ...clean(),
        humanCallouts: Array.from({ length: 30 }, (_value, index) => `second-${index}`),
      },
    },
  ]);
  assert.equal(callouts.submission.humanCallouts.length, 30);
  assert.equal(
    callouts.reviewers.reduce((total, reviewer) => total + reviewer.humanCallouts.length, 0),
    30,
  );

  const blocked = aggregateReviewerPanel([
    { profile: profiles[0]!, submission: clean() },
    {
      profile: profiles[1]!,
      submission: {
        verdict: "blocked",
        findings: [],
        humanCallouts: [],
        blockedReason: "Could not inspect generated code.",
      },
    },
  ]);
  assert.equal(blocked.submission.verdict, "blocked");
  assert.match(blocked.submission.blockedReason ?? "", /Adversarial reviewer 2/);
});

test("preserves the originating panel failure while aborting sibling reviewers", async () => {
  const { target } = await fixture();
  const reviewer: ReviewerRunner = {
    async review(input): Promise<ReviewerRunOutput> {
      if (input.reviewer.id === "adversarial-2") {
        throw new ReviewerProtocolError("Adversarial reviewer protocol failed.");
      }
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("Sibling reviewer aborted.");
          error.name = "AbortError";
          reject(error);
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    },
  };

  const result = await runReviewLoop({
    target,
    settings: settings({ reviewMode: "adversarial", reviewerCount: 2 }),
    models,
    reviewer,
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /Adversarial reviewer protocol failed/);
});

test("retains reviewer usage when a terminal protocol failure is thrown", async () => {
  const { target } = await fixture();
  const reviewer: ReviewerRunner = {
    async review(input): Promise<ReviewerRunOutput> {
      input.onUsage?.(billedUsage);
      throw new ReviewerProtocolError("Reviewer protocol failed after retry.");
    },
  };
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer,
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.usage, billedUsage);
});

test("retains fixer usage when a terminal protocol failure is thrown", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer: FixerRunner = {
    async fix(input): Promise<FixerRunOutput> {
      input.onUsage?.(billedUsage);
      throw new FixerProtocolError("Fixer protocol failed after retry.");
    },
    async dispose(): Promise<void> {
      return undefined;
    },
  };
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.usage, billedUsage);
});

test("blocks when configured verification is skipped for a pull-request checkout", async () => {
  const { target: baseTarget } = await fixture();
  const target: ReviewTargetSnapshot = {
    ...baseTarget,
    type: "pullRequest",
    pullRequest: { number: 42, title: "Untrusted", baseBranch: "main" },
  };
  let verificationCalls = 0;
  const result = await runReviewLoop({
    target,
    settings: settings({ verificationCommand: "pnpm test" }),
    models,
    reviewer: new SequenceReviewer([clean()]),
    createFixer: () => new FakeFixer(() => undefined),
    host: {
      execute: executor(),
      verify: async () => {
        verificationCalls += 1;
        return { configured: true, command: "pnpm test", passed: true };
      },
    },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /verification was skipped/i);
  assert.equal(verificationCalls, 0);
  assert.equal(result.verification.configured, true);
  assert.equal(result.verification.passed, false);
  assert.equal(result.verification.skipped, true);
  assert.match(result.verification.output ?? "", /untrusted pull-request checkout/);
  assert.doesNotMatch(resultContextContent(result), /Verification failed/);
  assert.match(resultContextContent(result), /Verification skipped/);
});

test("snapshots ignored paths before baseline verification", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, ".gitignore"), ".env\n", "utf8");
  await writeFile(join(root, ".env"), "user-owned\n", "utf8");
  let verificationCalls = 0;
  let protectedInitiallyIgnoredPath = false;
  const fixer = new FakeFixer(async (input) => {
    const initiallyIgnoredPaths = input.initiallyIgnoredPaths ?? [];
    assert.ok(initiallyIgnoredPaths.includes(".env"));
    await assert.rejects(
      assertMutationPath(input.target, ".env", initiallyIgnoredPaths),
      /ignored path/,
    );
    protectedInitiallyIgnoredPath = true;
    await writeFile(join(root, "a.ts"), "fixed\n", "utf8");
  });

  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => fixer,
    host: {
      execute: executor(),
      verify: async () => {
        verificationCalls += 1;
        if (verificationCalls === 1) await writeFile(join(root, ".gitignore"), "", "utf8");
        return { configured: true, passed: true };
      },
    },
  });

  assert.equal(result.status, "clean");
  assert.equal(protectedInitiallyIgnoredPath, true);
});

test("fails a clean result when final diagnostics are unavailable", async () => {
  const { target } = await fixture();
  const executeGit = executor();
  let headCalls = 0;
  const execute: ExecGit = async (command, args, options) => {
    if (command === "git" && args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD") {
      headCalls += 1;
      if (headCalls === 8) {
        return {
          stdout: "",
          stderr: "final diagnostics unavailable",
          code: 1,
          killed: false,
        };
      }
    }
    return executeGit(command, args, options);
  };
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([clean()]),
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute, verify: noVerification },
  });
  assert.equal(result.status, "failed");
  assert.match(result.reason ?? "", /Could not complete final diagnostics/);
  assert.match(result.reason ?? "", /final diagnostics unavailable/);
});

test("requires the configured number of clean runs on one fingerprint", async () => {
  const { target } = await fixture();
  const reviewer = new SequenceReviewer([clean(), clean()]);
  const result = await runReviewLoop({
    target,
    settings: settings({ requiredCleanRuns: 2 }),
    models,
    reviewer,
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "clean");
  assert.equal(result.passes.length, 2);
  assert.equal(reviewer.index, 2);
});

test("resets clean runs when verification changes the target", async () => {
  const { root, target } = await fixture();
  const reviewer = new SequenceReviewer([clean()]);
  let verificationCalls = 0;
  const verify = async (): Promise<VerificationResult> => {
    verificationCalls += 1;
    if (verificationCalls === 3) await writeFile(join(root, "a.ts"), "changed\n", "utf8");
    if (verificationCalls === 4) await writeFile(join(root, "a.ts"), "good\n", "utf8");
    return { configured: true, passed: true };
  };
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: 5, requiredCleanRuns: 2 }),
    models,
    reviewer,
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify },
  });

  assert.equal(result.status, "clean");
  assert.equal(result.passes.length, 5);
  assert.equal(reviewer.index, 5);
});

test("fixes findings and requires a fresh reviewer to confirm", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer = new FakeFixer(async () => writeFile(join(root, "a.ts"), "good again\n", "utf8"));
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "clean");
  assert.equal(result.passes.length, 2);
  assert.equal(result.findingsFixed, 1);
  assert.equal(result.ledger[0]?.status, "fixed");
  assert.equal(result.ledger[0]?.candidateStatus, undefined);
  assert.equal(fixer.calls, 1);
});

test("allows a fresh post-fix review with an unlimited pass cap", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: "unlimited" }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => new FakeFixer(async () => writeFile(join(root, "a.ts"), "fixed\n", "utf8")),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "clean");
  assert.equal(result.passes.length, 2);
});

test("exhausts when the pass limit leaves no fresh post-fix review", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: 1 }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
    ]),
    createFixer: () => new FakeFixer(async () => writeFile(join(root, "a.ts"), "fixed\n", "utf8")),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "exhausted");
  assert.match(result.reason ?? "", /fresh clean review/);
  assert.equal(result.findingsFixed, 0);
  assert.equal(result.ledger[0]?.status, "pending");
  assert.equal(result.ledger[0]?.candidateStatus, "fixed");
  assert.match(resultContextContent(result), /unconfirmed fixer report: fixed/);
});

test("does not confirm candidate fixes from a blocked review", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      {
        verdict: "blocked",
        findings: [],
        humanCallouts: [],
        blockedReason: "Inspection was unavailable.",
      },
    ]),
    createFixer: () => new FakeFixer(async () => writeFile(join(root, "a.ts"), "fixed\n", "utf8")),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.findingsFixed, 0);
  assert.equal(result.ledger[0]?.status, "pending");
  assert.equal(result.ledger[0]?.candidateStatus, "fixed");
});

test("retains findings reported with a blocked verdict", async () => {
  const { target } = await fixture();
  const blockedFinding = { ...finding(1), title: "Observed before blocking" };
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      {
        verdict: "blocked",
        findings: [blockedFinding],
        humanCallouts: [],
        blockedReason: "Inspection was only partially available.",
      },
    ]),
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.ledger[0]?.title, "Observed before blocking");
  assert.equal(result.ledger[0]?.status, "queued");
  assert.match(result.ledger[0]?.explanation ?? "", /Unconfirmed finding/);
});

test("blocks recurring findings on an unchanged target", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      { verdict: "findings", findings: [finding(2)], humanCallouts: [] },
    ]),
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /same findings recurred/i);
});

test("bounds recurring findings despite unrelated fixer edits", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer = new FakeFixer(async (_input, call) => {
    await writeFile(join(root, "unrelated.ts"), `unrelated ${call}\n`, "utf8");
  });
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: "unlimited" }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      { verdict: "findings", findings: [finding(2)], humanCallouts: [] },
      { verdict: "findings", findings: [finding(3)], humanCallouts: [] },
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /bounded fixer attempts/i);
  assert.equal(fixer.calls, 2);
  assert.equal(result.ledger[0]?.status, "recurring");
});

test("bounds alternating recurring findings across intervening passes", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const alternatingFinding = (pass: number, name: "a" | "b"): ReviewFinding => ({
    ...finding(pass),
    id: `RL-${name}`,
    fingerprint: `fingerprint-${name}`,
    title: `Defect ${name.toUpperCase()}`,
  });
  const fixer = new FakeFixer(() => undefined);
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: "unlimited" }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [alternatingFinding(1, "a")], humanCallouts: [] },
      { verdict: "findings", findings: [alternatingFinding(2, "b")], humanCallouts: [] },
      { verdict: "findings", findings: [alternatingFinding(3, "a")], humanCallouts: [] },
      { verdict: "findings", findings: [alternatingFinding(4, "b")], humanCallouts: [] },
      { verdict: "findings", findings: [alternatingFinding(5, "a")], humanCallouts: [] },
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /bounded fixer attempts/i);
  assert.equal(fixer.calls, 4);
  assert.equal(
    result.ledger.find((entry) => entry.fingerprint === "fingerprint-a")?.status,
    "recurring",
  );
});

test("unlimited continues beyond the former pass and fixer limits", async () => {
  const { target } = await fixture();
  let reviews = 0;
  const reviewer: ReviewerRunner = {
    async review(): Promise<ReviewerRunOutput> {
      reviews += 1;
      return {
        submission:
          reviews > 21
            ? clean()
            : {
                verdict: "findings",
                findings: [
                  {
                    ...finding(reviews),
                    id: `RL-changing-${reviews}`,
                    fingerprint: `changing-${reviews}`,
                    title: `Reworded defect ${reviews}`,
                    startLine: reviews,
                    endLine: reviews,
                  },
                ],
                humanCallouts: [],
              },
        usage: emptyUsage(),
        protocolRetries: 0,
      };
    },
  };
  const fixer = new FakeFixer(() => undefined);
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: "unlimited" }),
    models,
    reviewer,
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });

  assert.equal(result.status, "clean");
  assert.equal(fixer.calls, 21);
  assert.equal(reviews, 22);
});

test("aborts promptly while preserving completed fixer edits", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const controller = new AbortController();
  const fixer = new FakeFixer(async () => {
    await writeFile(join(root, "a.ts"), "partially fixed\n", "utf8");
    controller.abort();
  });
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
    signal: controller.signal,
  });
  assert.equal(result.status, "aborted");
  assert.equal(result.editsMayRemain, true);
  assert.match(result.reason ?? "", /left in place/);
});

test("reports excluded P3 findings without blocking convergence", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "changed\n", "utf8");
  const result = await runReviewLoop({
    target,
    settings: settings({ fixP3Findings: false }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1, "P3")], humanCallouts: [] },
    ]),
    createFixer: () => new FakeFixer(() => undefined),
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "clean");
  assert.equal(result.excludedFindings.length, 1);
});

test("invalidates clean results changed during fixer disposal", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer = new FakeFixer(
    () => writeFile(join(root, "a.ts"), "fixed\n", "utf8"),
    () => writeFile(join(root, "a.ts"), "changed during disposal\n", "utf8"),
  );
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /changed after its final clean review/);
});

test("blocks folder runs when fixer disposal changes an outside-scope file", async () => {
  const { root, target: uncommittedTarget } = await fixture();
  await mkdir(join(root, "selected"));
  await writeFile(join(root, "selected", "value.ts"), "bad\n", "utf8");
  const target: ReviewTargetSnapshot = {
    ...uncommittedTarget,
    type: "folder",
    paths: ["selected"],
    baseSha: undefined,
  };
  const selectedFinding = { ...finding(1), path: "selected/value.ts" };
  const fixer = new FakeFixer(
    () => writeFile(join(root, "selected", "value.ts"), "fixed\n", "utf8"),
    () => writeFile(join(root, "a.ts"), "changed outside scope during disposal\n", "utf8"),
  );
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [selectedFinding], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /outside the selected folder scope/);
});

test("invalidates clean results when fixer disposal changes the branch", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer = new FakeFixer(
    () => writeFile(join(root, "a.ts"), "fixed\n", "utf8"),
    async () => {
      await execFileAsync("git", ["switch", "-c", "changed-during-disposal"], { cwd: root });
    },
  );
  const result = await runReviewLoop({
    target,
    settings: settings(),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
      clean(),
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /Active branch changed/);
});

test("reports branch changes during fixer disposal after exhaustion", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "a.ts"), "bad\n", "utf8");
  const fixer = new FakeFixer(
    () => writeFile(join(root, "a.ts"), "fixed\n", "utf8"),
    async () => {
      await execFileAsync("git", ["switch", "-c", "changed-after-exhaustion"], { cwd: root });
    },
  );
  const result = await runReviewLoop({
    target,
    settings: settings({ maximumPasses: 1 }),
    models,
    reviewer: new SequenceReviewer([
      { verdict: "findings", findings: [finding(1)], humanCallouts: [] },
    ]),
    createFixer: () => fixer,
    host: { execute: executor(), verify: noVerification },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /Active branch changed/);
});

test("bounds verification repair and re-reviews repaired code", async () => {
  const { root, target } = await fixture();
  let verificationCalls = 0;
  const verify = async (): Promise<VerificationResult> => {
    verificationCalls += 1;
    return verificationCalls < 3
      ? { configured: true, command: "check", passed: false, exitCode: 1, output: "failed" }
      : { configured: true, command: "check", passed: true, exitCode: 0 };
  };
  const fixer = new FakeFixer(async () =>
    writeFile(join(root, "a.ts"), "verification repair\n", "utf8"),
  );
  const result = await runReviewLoop({
    target,
    settings: settings({ verificationCommand: "check" }),
    models,
    reviewer: new SequenceReviewer([clean(), clean()]),
    createFixer: () => fixer,
    host: { execute: executor(), verify },
  });
  assert.equal(result.status, "clean");
  assert.equal(fixer.calls, 1);
  assert.equal(result.passes.length, 2);
});
