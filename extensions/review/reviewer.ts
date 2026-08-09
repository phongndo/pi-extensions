import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createChildSession,
  disposeChildSession,
  promptChild,
  type TrustedContextFile,
} from "./child-session.ts";
import {
  getChangedFiles,
  getTargetDiff,
  GitClient,
  parseChangedLines,
  type ExecGit,
} from "./git.ts";
import type { NormalizedReviewSubmission, ReviewSubmission, UsageSummary } from "./models.ts";
import { emptyUsage, addUsage } from "./models.ts";
import type { GitMetadataPathCache } from "./path-safety.ts";
import {
  buildReviewerPrompt,
  reviewerPathInventoryByteBudget,
  REVIEWER_SYSTEM_PROMPT,
  type ReviewerPromptOptions,
} from "./prompts.ts";
import {
  asReviewSubmission,
  fixerFindingsByteBudget,
  MAX_REVIEW_FINDINGS,
  reviewSubmissionSchemaForMaxFindings,
  validateReviewSubmission,
  type ReviewSubmissionInput,
  type ValidateReviewOptions,
} from "./protocol.ts";

const REQUIRED_REVIEWER_TOOLS = ["read", "grep", "find", "ls", "bash", "submit_review"] as const;

export function reviewerActiveTools(inherited: readonly string[]): string[] {
  return [
    ...new Set([
      ...inherited.filter((name) => name !== "edit" && name !== "write"),
      ...REQUIRED_REVIEWER_TOOLS,
    ]),
  ];
}

interface ReviewerPassValues {
  changedFiles: string[];
  validationDiff: string;
}

export class ReviewerPassCache {
  readonly metadataPaths: GitMetadataPathCache = new Map();
  private readonly operations = new Map<keyof ReviewerPassValues, Promise<unknown>>();

  get<K extends keyof ReviewerPassValues>(
    key: K,
    start: () => Promise<ReviewerPassValues[K]>,
  ): Promise<ReviewerPassValues[K]> {
    const cached = this.operations.get(key) as Promise<ReviewerPassValues[K]> | undefined;
    if (cached) return cached;

    const pending = start();
    this.operations.set(key, pending);
    // Observe only to evict the failed entry. The original promise remains rejected for every
    // current waiter, while a later retry can start a fresh host operation.
    void pending.catch(() => {
      if (this.operations.get(key) === pending) this.operations.delete(key);
    });
    return pending;
  }
}

export function createReviewerPassCache(): ReviewerPassCache {
  return new ReviewerPassCache();
}

function reviewerTools(
  capture: (submission: ReviewSubmission) => void,
  maxFindings: number,
): ToolDefinition<any, any, any>[] {
  const submitReview = defineTool({
    name: "submit_review",
    label: "Submit Review",
    description: "Submit the final structured review and terminate this reviewer run.",
    parameters: reviewSubmissionSchemaForMaxFindings(maxFindings),
    async execute(_toolCallId, params: ReviewSubmissionInput) {
      capture(asReviewSubmission(params));
      return {
        content: [
          {
            type: "text" as const,
            text: `Review submitted with ${params.findings.length} finding(s).`,
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });

  return [submitReview];
}

export class ReviewerProtocolError extends Error {
  override name = "ReviewerProtocolError";
}

export async function validateReviewerResult(
  value: unknown,
  options: ValidateReviewOptions,
): Promise<NormalizedReviewSubmission> {
  try {
    return await validateReviewSubmission(value, options);
  } catch (error) {
    throw new ReviewerProtocolError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

export interface ReviewerRunInput extends ReviewerPromptOptions {
  reviewerCount: number;
  passCache?: ReviewerPassCache;
  signal?: AbortSignal;
  onUsage?: (usage: UsageSummary) => void;
}

export interface ReviewerRunOutput {
  submission: NormalizedReviewSubmission;
  usage: UsageSummary;
  protocolRetries: number;
}

export interface ReviewerRunner {
  review(input: ReviewerRunInput): Promise<ReviewerRunOutput>;
}

export interface SdkReviewerOptions {
  execute: ExecGit;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  contextFiles: TrustedContextFile[];
  fixerContextWindow: number;
  inheritedToolNames?: string[];
}

export class SdkReviewer implements ReviewerRunner {
  private readonly options: SdkReviewerOptions;

  constructor(options: SdkReviewerOptions) {
    this.options = options;
  }

  async review(input: ReviewerRunInput): Promise<ReviewerRunOutput> {
    const usage = emptyUsage();
    const passCache = input.passCache ?? createReviewerPassCache();
    let protocolReason: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let submissions: ReviewSubmission[] = [];
      const git = new GitClient(this.options.execute, input.target.repositoryRoot, input.signal);
      const changedFiles = await passCache.get("changedFiles", () =>
        getChangedFiles(git, input.target),
      );
      const maxFindings = Math.max(1, Math.floor(MAX_REVIEW_FINDINGS / input.reviewerCount));
      const pathInventoryByteBudget = reviewerPathInventoryByteBudget(
        this.options.model.contextWindow,
      );
      const tools = reviewerTools((submission) => {
        submissions = [...submissions, structuredClone(submission)];
      }, maxFindings);
      const activeTools = reviewerActiveTools(this.options.inheritedToolNames ?? []);
      const session = await createChildSession({
        cwd: input.target.repositoryRoot,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        tools: activeTools,
        customTools: tools,
        contextFiles: this.options.contextFiles,
        // Trust the user's normal global extensions, but never load project-owned extension code.
        projectTrusted: false,
        extensionsEnabled: true,
      });
      try {
        const prompt = buildReviewerPrompt(
          {
            ...input,
            changedFiles,
            protocolRetryReason: protocolReason,
          },
          pathInventoryByteBudget,
        );
        await promptChild(session, prompt, input.signal, (addition) => {
          addUsage(usage, addition);
          input.onUsage?.(addition);
        });
        if (submissions.length !== 1) {
          throw new Error(
            submissions.length === 0
              ? "Reviewer did not call submit_review."
              : "Reviewer called submit_review more than once.",
          );
        }
        const changedLines =
          input.target.type === "folder"
            ? undefined
            : parseChangedLines(
                await passCache.get("validationDiff", () => getTargetDiff(git, input.target, 0)),
                changedFiles,
              );
        const submission = await validateReviewerResult(submissions[0], {
          target: input.target,
          pass: input.pass,
          changedLines,
          maxFindings,
          // Each independent member may use the full eventual panel budget. The orchestrator
          // enforces that budget once duplicate panel findings have been merged.
          maxFindingsBytes: fixerFindingsByteBudget(this.options.fixerContextWindow),
          metadataCache: passCache.metadataPaths,
          signal: input.signal,
        });
        return { submission, usage, protocolRetries: attempt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isProtocolError =
          error instanceof ReviewerProtocolError ||
          message.includes("submit_review") ||
          message.startsWith("Review submission") ||
          message.startsWith("Review verdict") ||
          message.startsWith("A clean review") ||
          message.startsWith("A findings verdict") ||
          message.startsWith("A blocked review") ||
          message.startsWith("findings") ||
          message.startsWith("humanCallouts") ||
          message.startsWith("Finding ") ||
          message.startsWith("All submitted");
        if (!isProtocolError || input.signal?.aborted) throw error;
        if (attempt === 1) {
          if (error instanceof ReviewerProtocolError) throw error;
          throw new ReviewerProtocolError(message, { cause: error });
        }
        protocolReason = message;
      } finally {
        await disposeChildSession(session);
      }
    }
    throw new Error("Reviewer protocol failed after retry.");
  }
}
