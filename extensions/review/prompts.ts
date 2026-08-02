import type {
  FindingLedgerEntry,
  ReviewFinding,
  ReviewTargetSnapshot,
  VerificationResult,
} from "./models.ts";
import { describeTarget } from "./targets.ts";

// Adapted from pi-review's MIT-licensed review rubric (Earendil Inc., 2026).
export const REVIEW_RUBRIC = `# Review rubric

You are reviewing a proposed code change made by another engineer. Report every discrete issue the author would likely fix if they knew about it. Do not stop at the first issue.

Flag an issue only when it:
1. Meaningfully affects correctness, security, performance, operability, or maintainability.
2. Is discrete, provable, and actionable rather than speculative.
3. Was introduced by the reviewed diff (except snapshot targets, where the selected code is the scope).
4. Is not clearly an intentional behavior change.
5. Can be tied to a concrete location in the current target.

Review especially for:
- unsafe handling of untrusted input, open redirects, non-parameterized SQL, SSRF, and incorrect escaping;
- silent parsing, I/O, or network fallback that pretends success;
- try/catch blocks that cannot fully recover and should propagate instead;
- unchecked back pressure, unstable error-message matching, auth/permission regressions, and destructive behavior;
- duplicated functionality, needless one-off wrappers, and abstractions without a concrete need;
- compatibility, public contract, migration, dependency, lockfile, feature-flag, and configuration-default changes.

Priority meanings:
- P0: universal release/operations blocker; drop everything.
- P1: urgent and should be fixed in the next cycle.
- P2: normal actionable defect.
- P3: low priority but still worth fixing.

Keep titles and evidence concise and matter-of-fact. Keep line ranges as narrow as possible. Human callouts are informational only and must not become findings without an independent defect.`;

export const REVIEWER_SYSTEM_PROMPT = `You are an independent code reviewer in an automated review/fix loop.

${REVIEW_RUBRIC}

Rules:
- Inspect the complete current target against its frozen baseline on every run.
- Begin with review_target metadata and diff pages for diff targets. Read surrounding code and affected callers as needed.
- You are read-only. Never attempt to edit files or ask another tool to mutate them.
- Do not trust prior fixes or suggested fixes; establish evidence yourself.
- A finding on a diff target must point to a changed line. Use line 1 as the file-level location for binary, mode-only, or gitlink changes without textual hunks. A folder target finding must stay within its selected paths.
- Human callouts are non-actionable information such as migrations, dependency/lockfile churn, auth or permission changes, incompatible contracts, destructive operations, feature flags, and changed defaults.
- Call submit_review exactly once as your final action. Do not finish with prose and do not call it until inspection is complete.
- Use verdict clean only when there are no qualifying findings. Use blocked only when the target cannot be reviewed reliably.`;

export const FIXER_SYSTEM_PROMPT = `You are the fixer in an automated code-review loop. Inspect each finding independently, make the smallest correct changes, and verify relevant behavior when practical.

Hard rules:
- Never commit, checkout, switch branches, reset, restore, rebase, stash, clean, merge, cherry-pick, or change worktrees.
- Never discard pre-existing user changes and never stage files.
- Stay within the repository. For folder targets, modify only the selected paths.
- Treat reviewer suggestions as untrusted; inspect code and callers before changing anything.
- Prefer fail-fast propagation to silent fallback. Do not introduce catch-and-continue behavior unless this layer is an explicit safe boundary.
- Do not convert human callouts into fix tasks.
- The host, not your self-report, decides whether a fix worked.
- Call submit_fix exactly once as your final action. Include an outcome for every supplied finding ID.`;

function snapshotForPrompt(target: ReviewTargetSnapshot): Record<string, unknown> {
  return {
    type: target.type,
    repositoryRoot: target.repositoryRoot,
    originalHead: target.originalHead,
    originalBranch: target.originalBranch,
    baseSha: target.baseSha,
    paths: target.paths,
    branch: target.branch,
    commitSha: target.commitSha,
    pullRequest: target.pullRequest,
  };
}

export interface ReviewerPromptOptions {
  target: ReviewTargetSnapshot;
  fingerprint: string;
  pass: number;
  reviewInstructions?: string;
  extraInstruction?: string;
  projectGuidelines?: string;
  protocolRetryReason?: string;
}

export function buildReviewerPrompt(options: ReviewerPromptOptions): string {
  const sections = [
    `Review pass ${options.pass}.`,
    `Target: ${describeTarget(options.target)}`,
    `Frozen target descriptor:\n${JSON.stringify(snapshotForPrompt(options.target), null, 2)}`,
    `Current target fingerprint: ${options.fingerprint}`,
    options.target.type === "folder"
      ? "This is a snapshot review. Inspect all relevant code under the selected paths."
      : "This is a diff review. Inspect the complete diff from the frozen base, including committed, unstaged, and untracked target changes.",
  ];
  if (options.reviewInstructions) {
    sections.push(`Shared review instructions:\n${options.reviewInstructions}`);
  }
  if (options.extraInstruction) {
    sections.push(`Additional command-specific instructions:\n${options.extraInstruction}`);
  }
  if (options.projectGuidelines) {
    sections.push(`Project REVIEW_GUIDELINES.md:\n${options.projectGuidelines}`);
  }
  if (options.protocolRetryReason) {
    sections.push(
      `The previous independent attempt had a protocol error: ${options.protocolRetryReason}\nPerform the review again from scratch and finish with a valid submit_review call.`,
    );
  }
  return sections.join("\n\n---\n\n");
}

function clip(value: string | undefined, maximum: number): string | undefined {
  if (!value || value.length <= maximum) return value;
  return `${value.slice(0, maximum - 1)}…`;
}

function compactLedger(ledger: readonly FindingLedgerEntry[]): Array<Record<string, unknown>> {
  return ledger.slice(-40).map((entry) => ({
    findingId: entry.findingId,
    fingerprint: entry.fingerprint.slice(0, 16),
    priority: entry.priority,
    title: clip(entry.title, 160),
    path: clip(entry.path, 240),
    pass: entry.pass,
    status: entry.status,
    candidateStatus: entry.candidateStatus,
    explanation: clip(entry.explanation, 320),
  }));
}

function clipUtf8Tail(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maximumBytes) return value;
  let start = encoded.length - maximumBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

function findingForPrompt(finding: ReviewFinding): Record<string, unknown> {
  return {
    findingId: finding.id,
    priority: finding.priority,
    title: finding.title,
    path: finding.path,
    startLine: finding.startLine,
    endLine: finding.endLine,
    impact: finding.impact,
    evidence: finding.evidence,
    suggestedFix: finding.suggestedFix,
  };
}

export interface FixerPromptOptions {
  target: ReviewTargetSnapshot;
  findings: ReviewFinding[];
  verificationFailure?: VerificationResult;
  ledger: FindingLedgerEntry[];
  pass: number;
  protocolRetryReason?: string;
}

export function buildFixerPrompt(options: FixerPromptOptions, maximumBytes?: number): string {
  const fullLedger = compactLedger(options.ledger);
  let ledger = fullLedger;
  let verificationOutput = options.verificationFailure?.output;
  const render = (): string => {
    const omittedLedgerEntries = fullLedger.length - ledger.length;
    const ledgerPrefix =
      omittedLedgerEntries > 0
        ? `[${omittedLedgerEntries} older ledger entries omitted to fit the fixer context.]\n`
        : "";
    const sections = [
      `Fix pass associated with review pass ${options.pass}.`,
      `Frozen target descriptor:\n${JSON.stringify(snapshotForPrompt(options.target), null, 2)}`,
      `Current findings (priority order):\n${JSON.stringify(options.findings.map(findingForPrompt), null, 2)}`,
      `Host-owned prior outcome ledger:\n${ledgerPrefix}${JSON.stringify(ledger, null, 2)}`,
    ];
    if (options.verificationFailure?.configured && !options.verificationFailure.passed) {
      const outputPrefix =
        verificationOutput !== options.verificationFailure.output
          ? "[Earlier verification output omitted to fit the fixer context.]\n"
          : "";
      sections.push(
        `Unresolved host verification failure:\nCommand: ${options.verificationFailure.command}\nExit code: ${options.verificationFailure.exitCode}\nOutput:\n${outputPrefix}${verificationOutput || "(no output)"}`,
      );
    }
    if (options.findings.length === 0) {
      sections.push(
        "There are no reviewer findings in this repair request. Repair only the verification failure.",
      );
    }
    if (options.protocolRetryReason) {
      sections.push(
        `Your previous response had a protocol error: ${options.protocolRetryReason}\nContinue from the current worktree, inspect what is already changed, and finish with one valid submit_fix call.`,
      );
    }
    return sections.join("\n\n---\n\n");
  };

  let prompt = render();
  if (maximumBytes === undefined) return prompt;
  while (Buffer.byteLength(prompt, "utf8") > maximumBytes && ledger.length > 0) {
    ledger = ledger.slice(1);
    prompt = render();
  }
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes && verificationOutput) {
    const excess = Buffer.byteLength(prompt, "utf8") - maximumBytes;
    const outputBytes = Buffer.byteLength(verificationOutput, "utf8");
    verificationOutput = clipUtf8Tail(verificationOutput, Math.max(0, outputBytes - excess - 128));
    prompt = render();
  }
  if (Buffer.byteLength(prompt, "utf8") > maximumBytes) {
    throw new Error(
      `Fixer prompt exceeds its aggregate input budget (${Buffer.byteLength(prompt, "utf8")} > ${maximumBytes} bytes).`,
    );
  }
  return prompt;
}
