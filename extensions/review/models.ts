import type { ModelThinkingLevel as ThinkingLevel } from "@earendil-works/pi-ai";

export const REVIEW_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

export const TERMINAL_STATUSES = ["clean", "blocked", "exhausted", "aborted", "failed"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export const REVIEW_MODES = ["standard", "adversarial"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export interface ModelReference {
  provider: string;
  modelId: string;
}

export type MaximumPasses = number | "unlimited";

export interface ReviewLoopSettings {
  version: 2;
  reviewMode: ReviewMode;
  /** Independent reviewer sessions launched concurrently on each pass. */
  reviewerCount: number;
  reviewerModel?: ModelReference;
  reviewerThinking?: ThinkingLevel;
  fixerModel?: ModelReference;
  fixerThinking?: ThinkingLevel;
  maximumPasses: MaximumPasses;
  requiredCleanRuns: number;
  fixP3Findings: boolean;
  fixerContext: "continuous" | "fresh";
  verificationCommand?: string;
  reviewInstructions?: string;
}

export type ReviewTargetRequest =
  | { type: "uncommitted" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title?: string }
  | { type: "pullRequest"; reference: string }
  | { type: "folder"; paths: string[] };

export interface PullRequestSnapshot {
  number: number;
  title: string;
  baseBranch: string;
  /** Whether the PR base belongs to the repository whose local project trust was established. */
  isCurrentRepository?: boolean;
}

export interface ReviewTargetSnapshot {
  type: "uncommitted" | "baseBranch" | "commit" | "pullRequest" | "folder";
  repositoryRoot: string;
  originalHead: string;
  originalBranch?: string;
  baseSha?: string;
  initialUntrackedPaths?: string[];
  /** Successful fixer mutations that must remain reviewable if later ignored. */
  retainedUntrackedPaths?: string[];
  paths?: string[];
  branch?: string;
  commitSha?: string;
  commitTitle?: string;
  pullRequest?: PullRequestSnapshot;
}

export interface RawReviewFinding {
  priority: ReviewPriority;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  impact: string;
  evidence: string;
  suggestedFix: string;
}

export interface ReviewFinding extends RawReviewFinding {
  id: string;
  fingerprint: string;
  pass: number;
  /** Independent panel members that reported this finding. */
  reportedBy?: string[];
}

export interface ReviewSubmission {
  verdict: "clean" | "findings" | "blocked";
  findings: RawReviewFinding[];
  humanCallouts: string[];
  blockedReason?: string;
}

export interface NormalizedReviewSubmission {
  verdict: "clean" | "findings" | "blocked";
  findings: ReviewFinding[];
  humanCallouts: string[];
  blockedReason?: string;
}

export interface FixOutcome {
  findingId: string;
  status: "fixed" | "invalid" | "deferred";
  explanation: string;
}

export interface CheckRunReport {
  command: string;
  exitCode: number;
}

export interface FixSubmission {
  status: "fixed" | "partial" | "blocked";
  outcomes: FixOutcome[];
  checksRun: CheckRunReport[];
  summary: string;
}

export interface VerificationResult {
  configured: boolean;
  command?: string;
  passed: boolean;
  exitCode?: number;
  output?: string;
  skipped?: boolean;
  aborted?: boolean;
}

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ResolvedRoleModel {
  reference: ModelReference;
  thinkingLevel: ThinkingLevel;
  displayName: string;
}

export interface FindingLedgerEntry {
  findingId: string;
  fingerprint: string;
  priority: ReviewPriority;
  title: string;
  path: string;
  pass: number;
  status: "queued" | "pending" | "fixed" | "invalid" | "deferred" | "recurring";
  reportedBy?: string[];
  candidateStatus?: "fixed" | "invalid";
  explanation?: string;
}

export interface ReviewPassReviewerRecord {
  reviewerId: string;
  reviewerLabel: string;
  verdict: "clean" | "findings" | "blocked";
  findingIds: string[];
  humanCallouts: string[];
  blockedReason?: string;
}

export interface ReviewPassRecord {
  pass: number;
  mode: ReviewMode;
  targetFingerprint: string;
  verdict: "clean" | "findings" | "blocked" | "protocol-failure";
  reviewers: ReviewPassReviewerRecord[];
  findingIds: string[];
  actionableFindingIds: string[];
  excludedFindingIds: string[];
  humanCallouts: string[];
  verification?: VerificationResult;
  fixerSummary?: string;
}

export type RunPhase =
  | "resolving-target"
  | "baseline-verification"
  | "reviewing"
  | "fixing"
  | "verifying"
  | "clean-pass"
  | "terminal";

export interface ReviewLoopRunState {
  version: 1;
  runId: string;
  startedAt: string;
  updatedAt: string;
  reviewMode?: ReviewMode;
  target?: ReviewTargetSnapshot;
  phase: RunPhase;
  completedPasses: number;
  targetFingerprint?: string;
  initialFingerprint?: string;
  terminalStatus?: TerminalStatus | "interrupted";
}

export interface ReviewLoopResult {
  version: 1;
  runId: string;
  status: TerminalStatus;
  reviewMode: ReviewMode;
  reason?: string;
  target?: ReviewTargetSnapshot;
  passes: ReviewPassRecord[];
  ledger: FindingLedgerEntry[];
  excludedFindings: ReviewFinding[];
  humanCallouts: string[];
  findingsFixed: number;
  initialStatus?: string;
  finalStatus?: string;
  initialFingerprint?: string;
  finalFingerprint?: string;
  verification: VerificationResult;
  reviewer: ResolvedRoleModel;
  fixer: ResolvedRoleModel;
  usage: UsageSummary;
  startedAt: string;
  finishedAt: string;
  editsMayRemain: boolean;
}

export interface ProgressUpdate {
  phase: RunPhase;
  pass: number;
  maximumPasses: MaximumPasses;
  detail?: string;
}

export function emptyUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(target: UsageSummary, addition: UsageSummary): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheRead += addition.cacheRead;
  target.cacheWrite += addition.cacheWrite;
  target.cost += addition.cost;
  target.turns += addition.turns;
}

export function formatModelReference(reference: ModelReference): string {
  return `${reference.provider}/${reference.modelId}`;
}
