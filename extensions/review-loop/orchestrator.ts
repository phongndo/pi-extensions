import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ResolvedModels } from "./child-session.ts";
import { FixerProtocolError, snapshotIgnoredPaths, type FixerRunner } from "./fixer.ts";
import {
  GitClient,
  isAbortError,
  outsideScopeFingerprint,
  repositoryFingerprint,
  targetFingerprint,
  type ExecGit,
} from "./git.ts";
import type {
  FindingLedgerEntry,
  FixSubmission,
  ProgressUpdate,
  ReviewFinding,
  ReviewLoopResult,
  ReviewLoopRunState,
  ReviewLoopSettings,
  ReviewPassRecord,
  ReviewTargetSnapshot,
  TerminalStatus,
  UsageSummary,
  VerificationResult,
} from "./models.ts";
import { addUsage, emptyUsage } from "./models.ts";
import type { ReviewerRunner } from "./reviewer.ts";
import { ReviewerProtocolError } from "./reviewer.ts";
import { assertTargetInvariants } from "./targets.ts";

const VERIFICATION_OUTPUT_LIMIT = 32 * 1024;
const STATUS_OUTPUT_LIMIT = 16 * 1024;
const VERIFICATION_REPAIR_LIMIT = 2;
const FINDING_FIXER_ATTEMPT_LIMIT = 2;

function passLimitReached(
  pass: number,
  maximumPasses: ReviewLoopSettings["maximumPasses"],
): boolean {
  return maximumPasses !== "unlimited" && pass >= maximumPasses;
}

function clipStatus(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= STATUS_OUTPUT_LIMIT) return value;
  let clipped = value.slice(0, STATUS_OUTPUT_LIMIT);
  while (Buffer.byteLength(clipped, "utf8") > STATUS_OUTPUT_LIMIT) clipped = clipped.slice(0, -1);
  return `${clipped}\n[status truncated]`;
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): { output: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk]);
  return combined.length <= VERIFICATION_OUTPUT_LIMIT
    ? { output: combined, truncated: false }
    : {
        output: combined.subarray(combined.length - VERIFICATION_OUTPUT_LIMIT),
        truncated: true,
      };
}

export async function runVerificationCommand(
  command: string | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  if (!command?.trim()) return { configured: false, passed: true };
  if (signal?.aborted) return { configured: true, command, passed: false, aborted: true };

  return new Promise<VerificationResult>((resolvePromise) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, {
      cwd,
      shell: true,
      detached,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputTruncated = false;
    let settled = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let cleanupPending = false;
    let pendingFinish: { exitCode: number; error?: string } | undefined;

    const append = (prefix: string, chunk: Buffer | string) => {
      const appended = appendTail(output, Buffer.from(`${prefix}${chunk.toString()}`));
      output = appended.output;
      outputTruncated ||= appended.truncated;
    };
    child.stdout?.on("data", (chunk: Buffer) => append("", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("", chunk));

    const finish = (exitCode: number, error?: string) => {
      if (settled) return;
      if (cleanupPending) {
        pendingFinish ??= { exitCode, error };
        return;
      }
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      const text = [
        outputTruncated
          ? `[verification output truncated; showing final ${VERIFICATION_OUTPUT_LIMIT / 1024} KiB]`
          : undefined,
        output.toString("utf8").trimEnd(),
        error,
      ]
        .filter(Boolean)
        .join("\n");
      resolvePromise({
        configured: true,
        command,
        passed: !aborted && exitCode === 0,
        exitCode,
        output: text || undefined,
        aborted: aborted || undefined,
      });
    };
    const killProcessGroup = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signalName);
      } catch {
        child.kill(signalName);
      }
    };
    const terminateWindowsTree = () => {
      if (!child.pid) {
        child.kill();
        return;
      }
      cleanupPending = true;
      let cleanupSettled = false;
      const complete = (error?: string) => {
        if (cleanupSettled) return;
        cleanupSettled = true;
        if (error) {
          append(output.length > 0 ? "\n" : "", error);
          child.kill("SIGKILL");
        }
        cleanupPending = false;
        const pending = pendingFinish;
        pendingFinish = undefined;
        if (pending) finish(pending.exitCode, pending.error);
      };
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", (error) => complete(`Could not terminate process tree: ${error.message}`));
      killer.on("close", (code) =>
        complete(code === 0 ? undefined : `Could not terminate process tree (taskkill ${code}).`),
      );
    };
    const abort = () => {
      aborted = true;
      if (process.platform === "win32") {
        terminateWindowsTree();
      } else {
        cleanupPending = true;
        killProcessGroup("SIGTERM");
        killTimer = setTimeout(() => {
          // The detached shell can exit while descendants in its process group survive.
          // Keep escalation alive and delay the aborted result until the group kill runs.
          killProcessGroup("SIGKILL");
          killTimer = undefined;
          cleanupPending = false;
          const pending = pendingFinish;
          pendingFinish = undefined;
          if (pending) finish(pending.exitCode, pending.error);
        }, 1_000);
      }
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => finish(-1, error.message));
    child.on("close", (code) => finish(code ?? -1));
  });
}

export interface OrchestratorHost {
  execute: ExecGit;
  verify?: (
    command: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<VerificationResult>;
  persist?: (state: ReviewLoopRunState) => void;
  progress?: (update: ProgressUpdate) => void;
  now?: () => Date;
}

export interface RunReviewLoopOptions {
  target: ReviewTargetSnapshot;
  settings: ReviewLoopSettings;
  models: ResolvedModels;
  reviewer: ReviewerRunner;
  createFixer: () => FixerRunner;
  host: OrchestratorHost;
  reviewInstructions?: string;
  extraInstruction?: string;
  projectGuidelines?: string;
  signal?: AbortSignal;
}

interface TerminalDecision {
  status: TerminalStatus;
  reason?: string;
}

function priorityRank(finding: ReviewFinding): number {
  return finding.priority === "P0"
    ? 0
    : finding.priority === "P1"
      ? 1
      : finding.priority === "P2"
        ? 2
        : 3;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniquePush(target: string[], values: readonly string[]): void {
  const known = new Set(target);
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !known.has(normalized)) {
      known.add(normalized);
      target.push(normalized);
    }
  }
}

function copyVerification(value: VerificationResult): VerificationResult {
  return { ...value };
}

function addUnreportedUsage(
  target: UsageSummary,
  total: UsageSummary,
  reported: UsageSummary,
): void {
  addUsage(target, {
    input: Math.max(0, total.input - reported.input),
    output: Math.max(0, total.output - reported.output),
    cacheRead: Math.max(0, total.cacheRead - reported.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - reported.cacheWrite),
    cost: Math.max(0, total.cost - reported.cost),
    turns: Math.max(0, total.turns - reported.turns),
  });
}

export async function runReviewLoop(options: RunReviewLoopOptions): Promise<ReviewLoopResult> {
  const now = options.host.now ?? (() => new Date());
  const configuredVerify = options.host.verify ?? runVerificationCommand;
  const verify = (
    command: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<VerificationResult> => {
    if (options.target.type === "pullRequest" && command?.trim()) {
      return Promise.resolve({
        configured: true,
        command,
        passed: false,
        skipped: true,
        output: "Skipped for an untrusted pull-request checkout.",
      });
    }
    return configuredVerify(command, cwd, signal);
  };
  const runId = randomUUID();
  const startedAt = now().toISOString();
  const usage = emptyUsage();
  const passes: ReviewPassRecord[] = [];
  const ledger: FindingLedgerEntry[] = [];
  const ledgerByFingerprint = new Map<string, FindingLedgerEntry>();
  const excludedByFingerprint = new Map<string, ReviewFinding>();
  const humanCallouts: string[] = [];
  const candidateOutcomes = new Map<string, "fixed" | "invalid">();
  const confirmedFixed = new Set<string>();
  const git = new GitClient(options.host.execute, options.target.repositoryRoot, options.signal);
  let fixer: FixerRunner | undefined;
  let initialStatus: string | undefined;
  let finalStatus: string | undefined;
  let initialFingerprint: string | undefined;
  let finalFingerprint: string | undefined;
  let initialRepositoryFingerprint: string | undefined;
  let initialOutsideFingerprint: string | undefined;
  let changesByLoop = false;
  let currentVerification: VerificationResult = { configured: false, passed: true };
  let terminal: TerminalDecision | undefined;
  let completedPasses = 0;
  let previousReview: { fingerprint: string; findings: string[] } | undefined;
  // Attempts are run-wide: an intermittent reviewer omission must not reset a recurring issue.
  const fixerAttemptCounts = new Map<string, number>();
  let cleanFingerprint: string | undefined;
  let cleanRuns = 0;
  let initiallyIgnoredPaths: readonly string[] = [];

  const state = (phase: ReviewLoopRunState["phase"], fingerprint?: string): ReviewLoopRunState => ({
    version: 1,
    runId,
    startedAt,
    updatedAt: now().toISOString(),
    target: options.target,
    phase,
    completedPasses,
    targetFingerprint: fingerprint,
    initialFingerprint,
    terminalStatus: terminal?.status,
  });
  const phase = (
    value: ReviewLoopRunState["phase"],
    pass: number,
    detail?: string,
    fingerprint?: string,
  ) => {
    options.host.persist?.(state(value, fingerprint));
    options.host.progress?.({
      phase: value,
      pass,
      maximumPasses: options.settings.maximumPasses,
      detail,
    });
  };
  const getFixer = (): FixerRunner => (fixer ??= options.createFixer());
  const setTerminal = (status: TerminalStatus, reason?: string): void => {
    terminal ??= { status, reason };
  };
  const upsertFinding = (finding: ReviewFinding): FindingLedgerEntry => {
    const existing = ledgerByFingerprint.get(finding.fingerprint);
    if (existing) {
      existing.findingId = finding.id;
      existing.pass = finding.pass;
      existing.priority = finding.priority;
      existing.title = finding.title;
      existing.path = finding.path;
      return existing;
    }
    const entry: FindingLedgerEntry = {
      findingId: finding.id,
      fingerprint: finding.fingerprint,
      priority: finding.priority,
      title: finding.title,
      path: finding.path,
      pass: finding.pass,
      status: "queued",
    };
    ledger.push(entry);
    ledgerByFingerprint.set(finding.fingerprint, entry);
    return entry;
  };
  const applyFixReport = (submission: FixSubmission, findings: ReviewFinding[]): void => {
    const byId = new Map(findings.map((finding) => [finding.id, finding]));
    for (const outcome of submission.outcomes) {
      const finding = byId.get(outcome.findingId);
      if (!finding) continue;
      const entry = upsertFinding(finding);
      entry.explanation = outcome.explanation;
      if (outcome.status === "deferred") {
        entry.status = "deferred";
        entry.candidateStatus = undefined;
        candidateOutcomes.delete(finding.fingerprint);
      } else {
        // A fixer report is only a candidate. Keep the finding unresolved until a later,
        // reliable review of the resulting target independently omits its fingerprint.
        entry.status = "pending";
        entry.candidateStatus = outcome.status;
        candidateOutcomes.set(finding.fingerprint, outcome.status);
      }
    }
  };
  const folderOutsideFingerprint = async (): Promise<string | undefined> =>
    options.target.type === "folder"
      ? outsideScopeFingerprint(git, options.target.repositoryRoot, options.target.paths ?? [])
      : undefined;

  const runFixer = async (
    pass: number,
    findings: ReviewFinding[],
    verificationFailure?: VerificationResult,
  ): Promise<{ beforeTarget: string; afterTarget: string; report: FixSubmission } | undefined> => {
    phase(
      "fixing",
      pass,
      findings.length > 0 ? `fixing ${findings.length} findings` : "repairing verification",
    );
    await assertTargetInvariants(git, options.target);
    const beforeTarget = await targetFingerprint(git, options.target);
    const beforeRepository = await repositoryFingerprint(git, options.target.repositoryRoot);
    const beforeOutside = await folderOutsideFingerprint();
    const reportedUsage = emptyUsage();
    const run = await getFixer().fix({
      target: options.target,
      findings,
      verificationFailure,
      initiallyIgnoredPaths,
      ledger,
      pass,
      signal: options.signal,
      onUsage: (addition) => {
        addUsage(reportedUsage, addition);
        addUsage(usage, addition);
      },
    });
    addUnreportedUsage(usage, run.usage, reportedUsage);
    await assertTargetInvariants(git, options.target);
    const afterTarget = await targetFingerprint(git, options.target);
    const afterRepository = await repositoryFingerprint(git, options.target.repositoryRoot);
    const afterOutside = await folderOutsideFingerprint();
    if (beforeOutside !== afterOutside) {
      setTerminal("blocked", "The fixer changed files outside the selected folder scope.");
      return undefined;
    }
    if (beforeRepository !== afterRepository || beforeTarget !== afterTarget) changesByLoop = true;
    applyFixReport(run.submission, findings);
    if (run.submission.status === "blocked") {
      setTerminal("blocked", run.submission.summary || "The fixer reported that it was blocked.");
      return undefined;
    }
    if (run.submission.outcomes.some((outcome) => outcome.status === "deferred")) {
      setTerminal("blocked", "The fixer deferred one or more actionable findings.");
      return undefined;
    }
    return { beforeTarget, afterTarget, report: run.submission };
  };

  const repairVerification = async (
    pass: number,
    failure: VerificationResult,
  ): Promise<VerificationResult> => {
    let result = failure;
    for (
      let attempt = 1;
      attempt <= VERIFICATION_REPAIR_LIMIT && !result.passed && !terminal;
      attempt += 1
    ) {
      const repaired = await runFixer(pass, [], result);
      if (!repaired || terminal) return result;
      phase("verifying", pass, `verification repair ${attempt}/${VERIFICATION_REPAIR_LIMIT}`);
      await assertTargetInvariants(git, options.target);
      result = await verify(
        options.settings.verificationCommand,
        options.target.repositoryRoot,
        options.signal,
      );
      await assertTargetInvariants(git, options.target);
      if (options.signal?.aborted || result.aborted)
        throw Object.assign(new Error("Review loop aborted."), { name: "AbortError" });
    }
    if (!result.passed && !terminal) {
      setTerminal(
        "blocked",
        `Verification failed after ${VERIFICATION_REPAIR_LIMIT} bounded repair attempts.`,
      );
    }
    return result;
  };

  try {
    phase("resolving-target", 0, "checking frozen target invariants");
    await assertTargetInvariants(git, options.target);
    initiallyIgnoredPaths =
      options.target.type === "folder"
        ? []
        : await snapshotIgnoredPaths(options.target.repositoryRoot, options.signal);
    initialStatus = clipStatus(await git.status());
    initialFingerprint = await targetFingerprint(git, options.target);
    initialRepositoryFingerprint = await repositoryFingerprint(git, options.target.repositoryRoot);
    initialOutsideFingerprint = await folderOutsideFingerprint();

    phase("baseline-verification", 0, "running baseline verification", initialFingerprint);
    currentVerification = await verify(
      options.settings.verificationCommand,
      options.target.repositoryRoot,
      options.signal,
    );
    await assertTargetInvariants(git, options.target);
    if (options.signal?.aborted || currentVerification.aborted) {
      throw Object.assign(new Error("Review loop aborted."), { name: "AbortError" });
    }
    if (options.target.type === "pullRequest" && options.settings.verificationCommand?.trim()) {
      setTerminal(
        "blocked",
        "Configured verification was skipped for the untrusted pull-request checkout.",
      );
    }

    for (
      let pass = 1;
      (options.settings.maximumPasses === "unlimited" || pass <= options.settings.maximumPasses) &&
      !terminal;
      pass += 1
    ) {
      await assertTargetInvariants(git, options.target);
      const reviewFingerprint = await targetFingerprint(git, options.target);
      phase("reviewing", pass, "running a fresh independent review", reviewFingerprint);
      const reportedUsage = emptyUsage();
      const reviewed = await options.reviewer.review({
        target: options.target,
        fingerprint: reviewFingerprint,
        pass,
        reviewInstructions: options.reviewInstructions,
        extraInstruction: options.extraInstruction,
        projectGuidelines: options.projectGuidelines,
        signal: options.signal,
        onUsage: (addition) => {
          addUsage(reportedUsage, addition);
          addUsage(usage, addition);
        },
      });
      addUnreportedUsage(usage, reviewed.usage, reportedUsage);
      completedPasses = pass;
      await assertTargetInvariants(git, options.target);
      const afterReviewFingerprint = await targetFingerprint(git, options.target);
      if (reviewFingerprint !== afterReviewFingerprint) {
        setTerminal(
          "blocked",
          "The review target changed while the read-only reviewer was running.",
        );
        break;
      }

      const allFingerprints = new Set(
        reviewed.submission.findings.map((finding) => finding.fingerprint),
      );
      uniquePush(humanCallouts, reviewed.submission.humanCallouts);

      const actionable = reviewed.submission.findings
        .filter((finding) => options.settings.fixP3Findings || finding.priority !== "P3")
        .sort((left, right) => priorityRank(left) - priorityRank(right));
      const excluded = reviewed.submission.findings.filter(
        (finding) => !options.settings.fixP3Findings && finding.priority === "P3",
      );
      for (const finding of excluded) excludedByFingerprint.set(finding.fingerprint, finding);
      const actionableFingerprints = actionable.map((finding) => finding.fingerprint).sort();
      const passRecord: ReviewPassRecord = {
        pass,
        targetFingerprint: reviewFingerprint,
        verdict: reviewed.submission.verdict,
        findingIds: reviewed.submission.findings.map((finding) => finding.id),
        actionableFindingIds: actionable.map((finding) => finding.id),
        excludedFindingIds: excluded.map((finding) => finding.id),
        humanCallouts: reviewed.submission.humanCallouts,
      };
      passes.push(passRecord);

      // A blocked review is not reliable evidence that omitted candidate findings are gone, but
      // retain any issues it did observe as unconfirmed unresolved findings for the final result.
      if (reviewed.submission.verdict === "blocked") {
        for (const finding of reviewed.submission.findings) {
          const entry = upsertFinding(finding);
          entry.status = "queued";
          entry.explanation = "Unconfirmed finding from a blocked review.";
        }
        setTerminal(
          "blocked",
          reviewed.submission.blockedReason ||
            "The reviewer could not inspect the target reliably.",
        );
        break;
      }

      for (const [fingerprint, candidateStatus] of candidateOutcomes) {
        const entry = ledgerByFingerprint.get(fingerprint);
        if (entry && entry.pass < pass && !allFingerprints.has(fingerprint)) {
          entry.status = candidateStatus;
          entry.candidateStatus = undefined;
          candidateOutcomes.delete(fingerprint);
          if (candidateStatus === "fixed") confirmedFixed.add(fingerprint);
        }
      }

      if (
        actionable.length > 0 &&
        previousReview?.fingerprint === reviewFingerprint &&
        sameStrings(previousReview.findings, actionableFingerprints)
      ) {
        for (const finding of actionable) {
          const entry = upsertFinding(finding);
          entry.status = "recurring";
          entry.candidateStatus = undefined;
          candidateOutcomes.delete(finding.fingerprint);
          confirmedFixed.delete(finding.fingerprint);
        }
        setTerminal("blocked", "The same findings recurred against an unchanged target.");
        break;
      }
      const boundedRecurring = actionable.filter(
        (finding) =>
          (fixerAttemptCounts.get(finding.fingerprint) ?? 0) >= FINDING_FIXER_ATTEMPT_LIMIT,
      );
      if (boundedRecurring.length > 0) {
        const recurringFingerprints = new Set(
          boundedRecurring.map((finding) => finding.fingerprint),
        );
        for (const finding of actionable) {
          const entry = upsertFinding(finding);
          entry.status = recurringFingerprints.has(finding.fingerprint) ? "recurring" : "queued";
          entry.candidateStatus = undefined;
          candidateOutcomes.delete(finding.fingerprint);
          confirmedFixed.delete(finding.fingerprint);
        }
        setTerminal("blocked", "One or more findings recurred after two bounded fixer attempts.");
        break;
      }
      previousReview = { fingerprint: reviewFingerprint, findings: actionableFingerprints };

      if (actionable.length > 0) {
        cleanRuns = 0;
        cleanFingerprint = undefined;
        for (const finding of actionable) {
          const entry = upsertFinding(finding);
          entry.status = "queued";
          entry.candidateStatus = undefined;
          candidateOutcomes.delete(finding.fingerprint);
          confirmedFixed.delete(finding.fingerprint);
        }
        for (const finding of actionable) {
          fixerAttemptCounts.set(
            finding.fingerprint,
            (fixerAttemptCounts.get(finding.fingerprint) ?? 0) + 1,
          );
        }
        const fixed = await runFixer(
          pass,
          actionable,
          currentVerification.configured && !currentVerification.passed
            ? currentVerification
            : undefined,
        );
        if (!fixed || terminal) break;
        passRecord.fixerSummary = fixed.report.summary;

        phase("verifying", pass, "running verification after fixes");
        currentVerification = await verify(
          options.settings.verificationCommand,
          options.target.repositoryRoot,
          options.signal,
        );
        await assertTargetInvariants(git, options.target);
        if (options.signal?.aborted || currentVerification.aborted) {
          throw Object.assign(new Error("Review loop aborted."), { name: "AbortError" });
        }
        if (!currentVerification.passed) {
          currentVerification = await repairVerification(pass, currentVerification);
        }
        passRecord.verification = copyVerification(currentVerification);
        if (terminal) break;
        if (passLimitReached(pass, options.settings.maximumPasses)) {
          setTerminal(
            "exhausted",
            "Maximum review passes reached before fixes could receive a fresh clean review.",
          );
        }
        continue;
      }

      phase("verifying", pass, "verifying the clean review target", reviewFingerprint);
      const beforeVerification = reviewFingerprint;
      currentVerification = await verify(
        options.settings.verificationCommand,
        options.target.repositoryRoot,
        options.signal,
      );
      await assertTargetInvariants(git, options.target);
      if (options.signal?.aborted || currentVerification.aborted) {
        throw Object.assign(new Error("Review loop aborted."), { name: "AbortError" });
      }
      const afterVerification = await targetFingerprint(git, options.target);
      passRecord.verification = copyVerification(currentVerification);

      if (!currentVerification.passed) {
        cleanFingerprint = undefined;
        cleanRuns = 0;
        currentVerification = await repairVerification(pass, currentVerification);
        passRecord.verification = copyVerification(currentVerification);
        if (terminal) break;
        if (passLimitReached(pass, options.settings.maximumPasses)) {
          setTerminal("exhausted", "Maximum review passes reached after verification repair.");
        }
        continue;
      }
      if (beforeVerification !== afterVerification) {
        cleanFingerprint = undefined;
        cleanRuns = 0;
        changesByLoop = true;
        if (passLimitReached(pass, options.settings.maximumPasses)) {
          setTerminal(
            "exhausted",
            "Verification changed the target and no fresh review pass remained.",
          );
        }
        continue;
      }

      if (cleanFingerprint === reviewFingerprint) cleanRuns += 1;
      else {
        cleanFingerprint = reviewFingerprint;
        cleanRuns = 1;
      }
      phase(
        "clean-pass",
        pass,
        `clean run ${cleanRuns}/${options.settings.requiredCleanRuns}`,
        reviewFingerprint,
      );
      if (cleanRuns >= options.settings.requiredCleanRuns) {
        setTerminal("clean");
      } else if (passLimitReached(pass, options.settings.maximumPasses)) {
        setTerminal(
          "exhausted",
          "Maximum review passes reached before the required clean-run count.",
        );
      }
    }

    if (!terminal) {
      setTerminal("exhausted", "Maximum review passes reached.");
    }
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      setTerminal("aborted", "Stopped by the user; completed file edits were left in place.");
    } else if (error instanceof ReviewerProtocolError || error instanceof FixerProtocolError) {
      setTerminal("blocked", error.message);
    } else if (
      error instanceof Error &&
      (error.message.startsWith("HEAD changed") ||
        error.message.startsWith("Active branch changed"))
    ) {
      setTerminal("blocked", error.message);
    } else {
      setTerminal("failed", error instanceof Error ? error.message : String(error));
    }
  } finally {
    try {
      await fixer?.dispose();
    } catch (error) {
      if (!terminal || terminal.status === "clean") {
        terminal = {
          status: "failed",
          reason: `Could not dispose the fixer session: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    try {
      // Final diagnostics must still run after the operation signal is aborted.
      const finalGit = new GitClient(options.host.execute, options.target.repositoryRoot);
      finalStatus = clipStatus(await finalGit.status());
      let invariantFailure: unknown;
      try {
        await assertTargetInvariants(finalGit, options.target);
      } catch (error) {
        invariantFailure = error;
      }
      if (invariantFailure) {
        terminal = {
          status: "blocked",
          reason:
            invariantFailure instanceof Error
              ? invariantFailure.message
              : "The frozen target invariants failed during final diagnostics.",
        };
      }
      finalFingerprint = await targetFingerprint(finalGit, options.target);
      const finalRepository = await repositoryFingerprint(finalGit, options.target.repositoryRoot);
      const finalOutsideFingerprint =
        options.target.type === "folder"
          ? await outsideScopeFingerprint(
              finalGit,
              options.target.repositoryRoot,
              options.target.paths ?? [],
            )
          : undefined;
      if (
        (initialRepositoryFingerprint && finalRepository !== initialRepositoryFingerprint) ||
        (initialFingerprint && finalFingerprint !== initialFingerprint)
      ) {
        changesByLoop = true;
      }
      if (
        initialOutsideFingerprint !== undefined &&
        finalOutsideFingerprint !== initialOutsideFingerprint
      ) {
        changesByLoop = true;
        terminal = {
          status: "blocked",
          reason: "Files outside the selected folder scope changed during the review loop.",
        };
      } else if (
        terminal?.status === "clean" &&
        cleanFingerprint &&
        finalFingerprint !== cleanFingerprint
      ) {
        terminal = {
          status: "blocked",
          reason:
            "The review target changed after its final clean review; a fresh review is required.",
        };
      }
    } catch (error) {
      if (terminal?.status === "clean") {
        terminal = {
          status: "failed",
          reason: `Could not complete final diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // Preserve an existing non-clean terminal reason when final diagnostics are unavailable.
    }
  }

  const decision = terminal ?? {
    status: "failed" as const,
    reason: "Review loop ended without a terminal decision.",
  };
  const finishedAt = now().toISOString();
  const terminalState = state("terminal", finalFingerprint);
  terminalState.terminalStatus = decision.status;
  terminalState.updatedAt = finishedAt;
  options.host.persist?.(terminalState);

  return {
    version: 1,
    runId,
    status: decision.status,
    reason: decision.reason,
    target: options.target,
    passes,
    ledger,
    excludedFindings: [...excludedByFingerprint.values()],
    humanCallouts,
    findingsFixed: confirmedFixed.size,
    initialStatus,
    finalStatus,
    initialFingerprint,
    finalFingerprint,
    verification: currentVerification,
    reviewer: options.models.reviewer,
    fixer: options.models.fixer,
    usage,
    startedAt,
    finishedAt,
    editsMayRemain: changesByLoop,
  };
}

export function aggregateUsage(values: readonly UsageSummary[]): UsageSummary {
  const result = emptyUsage();
  for (const value of values) addUsage(result, value);
  return result;
}
