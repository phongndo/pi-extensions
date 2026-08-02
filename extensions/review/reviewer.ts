import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createChildSession,
  disposeChildSession,
  promptChild,
  type TrustedContextFile,
} from "./child-session.ts";
import {
  getChangedFiles,
  getDiffStat,
  getTargetDiff,
  GitClient,
  parseChangedLines,
  type ExecGit,
} from "./git.ts";
import { createRepositoryInspectionTools } from "./inspection-tools.ts";
import type {
  NormalizedReviewSubmission,
  ReviewSubmission,
  ReviewTargetSnapshot,
  UsageSummary,
} from "./models.ts";
import { emptyUsage, addUsage } from "./models.ts";
import {
  buildReviewerPrompt,
  REVIEWER_SYSTEM_PROMPT,
  type ReviewerPromptOptions,
} from "./prompts.ts";
import {
  asReviewSubmission,
  fixerFindingsByteBudget,
  reviewSubmissionSchema,
  validateReviewSubmission,
  type ReviewSubmissionInput,
  type ValidateReviewOptions,
} from "./protocol.ts";
import { describeTarget } from "./targets.ts";

function boundedToolText(text: string): string {
  const result = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!result.truncated) return result.content;
  return `${result.content}\n\n[Output truncated: showing ${result.outputLines}/${result.totalLines} lines and ${result.outputBytes}/${result.totalBytes} bytes. Request another page when supported.]`;
}

const DIFF_PAGE_BYTE_BUDGET = DEFAULT_MAX_BYTES - 4_096;
const DIFF_LINE_CHUNK_BYTE_BUDGET = DIFF_PAGE_BYTE_BUDGET - 1_024;

function utf8ChunkEnd(buffer: Buffer, start: number, maximumBytes: number): number {
  let end = Math.min(buffer.length, start + maximumBytes);
  while (end > start && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

/** Paginate by line, with a UTF-8 byte cursor for an individual oversized line. */
export function formatDiffPage(
  lines: readonly string[],
  offset: number,
  limit: number,
  column = 0,
): string {
  const start = Math.min(offset, lines.length);
  if (!Number.isSafeInteger(column) || column < 0) {
    throw new Error("Diff column must be a non-negative integer.");
  }
  const page: string[] = [];
  let pageBytes = 0;
  let lineIndex = start;
  let consumed = 0;
  let partial: { line: number; startByte: number; endByte: number; totalBytes: number } | undefined;

  while (consumed < limit && lineIndex < lines.length) {
    const line = Buffer.from(lines[lineIndex]!);
    const byteOffset = lineIndex === start ? column : 0;
    if (byteOffset > line.length) {
      throw new Error(`Diff column ${byteOffset} exceeds line ${lineIndex + 1}.`);
    }
    if (byteOffset > 0 && byteOffset < line.length && (line[byteOffset]! & 0xc0) === 0x80) {
      throw new Error(`Diff column ${byteOffset} is not a UTF-8 character boundary.`);
    }
    const separatorBytes = page.length > 0 ? 1 : 0;
    const remainingBytes = line.length - byteOffset;
    if (pageBytes + separatorBytes + remainingBytes <= DIFF_PAGE_BYTE_BUDGET) {
      page.push(line.subarray(byteOffset).toString("utf8"));
      pageBytes += separatorBytes + remainingBytes;
      lineIndex += 1;
      consumed += 1;
      continue;
    }
    if (page.length === 0) {
      const endByte = utf8ChunkEnd(line, byteOffset, DIFF_LINE_CHUNK_BYTE_BUDGET);
      if (endByte <= byteOffset) throw new Error("Diff page budget cannot fit one character.");
      page.push(line.subarray(byteOffset, endByte).toString("utf8"));
      partial = {
        line: lineIndex,
        startByte: byteOffset,
        endByte,
        totalBytes: line.length,
      };
    }
    break;
  }

  if (partial) {
    return [
      `Diff line ${partial.line + 1} bytes ${partial.startByte}-${partial.endByte - 1} of ${partial.totalBytes}.`,
      page.join("\n"),
      `More of this diff line is available; request offset ${partial.line} column ${partial.endByte}.`,
    ].join("\n\n");
  }

  const heading =
    consumed > 0
      ? `Diff lines ${start + 1}-${lineIndex} of ${lines.length}${column > 0 ? `, starting at byte ${column}` : ""}.`
      : `Diff offset ${start} is at the end of ${lines.length} lines.`;
  return [
    heading,
    page.join("\n") || "(empty page)",
    lineIndex < lines.length
      ? `More diff is available; request offset ${lineIndex}.`
      : "End of diff.",
  ].join("\n\n");
}

export class ReviewTargetAccess {
  private readonly git: GitClient;
  private readonly target: ReviewTargetSnapshot;
  private diffLines: Promise<string[]> | undefined;

  constructor(git: GitClient, target: ReviewTargetSnapshot) {
    this.git = git;
    this.target = target;
  }

  private targetDiffLines(): Promise<string[]> {
    if (!this.diffLines) {
      this.diffLines = getTargetDiff(this.git, this.target, 3).then((diff) => diff.split("\n"));
    }
    return this.diffLines;
  }

  async execute(
    operation: "descriptor" | "status" | "files" | "stat" | "diff",
    offset: number,
    limit: number,
    column: number,
  ): Promise<string> {
    switch (operation) {
      case "descriptor":
        return JSON.stringify(
          {
            description: describeTarget(this.target),
            type: this.target.type,
            originalHead: this.target.originalHead,
            originalBranch: this.target.originalBranch,
            baseSha: this.target.baseSha,
            paths: this.target.paths,
            pullRequest: this.target.pullRequest,
          },
          null,
          2,
        );
      case "status":
        return (await this.git.status()) || "(clean worktree)";
      case "files":
        return (await getChangedFiles(this.git, this.target)).join("\n") || "(no changed files)";
      case "stat":
        return (await getDiffStat(this.git, this.target)) || "(empty diff)";
      case "diff": {
        if (this.target.type === "folder") {
          return "Folder targets are snapshots. Read files under the selected paths directly.";
        }
        return formatDiffPage(await this.targetDiffLines(), offset, limit, column);
      }
    }
  }
}

function reviewerTools(
  root: string,
  access: ReviewTargetAccess,
  capture: (submission: ReviewSubmission) => void,
): ToolDefinition<any, any, any>[] {
  const reviewTarget = defineTool({
    name: "review_target",
    label: "Review Target",
    description:
      "Inspect host-controlled review metadata, status, changed files, diff stats, or a bounded diff page. Diff offset is zero-based lines; column is a UTF-8 byte offset for continuing an oversized line.",
    parameters: Type.Object({
      operation: StringEnum(["descriptor", "status", "files", "stat", "diff"] as const),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000_000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 800 })),
      column: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000 })),
    }),
    async execute(_toolCallId, params) {
      const text = await access.execute(
        params.operation,
        params.offset ?? 0,
        params.limit ?? 400,
        params.column ?? 0,
      );
      return { content: [{ type: "text" as const, text: boundedToolText(text) }], details: {} };
    },
  });

  const submitReview = defineTool({
    name: "submit_review",
    label: "Submit Review",
    description: "Submit the final structured review and terminate this reviewer run.",
    parameters: reviewSubmissionSchema,
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

  // Keep the SDK definitions authoritative if this helper is reused with extensions enabled.
  return [...createRepositoryInspectionTools(root), reviewTarget, submitReview];
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
}

export class SdkReviewer implements ReviewerRunner {
  private readonly options: SdkReviewerOptions;

  constructor(options: SdkReviewerOptions) {
    this.options = options;
  }

  async review(input: ReviewerRunInput): Promise<ReviewerRunOutput> {
    const usage = emptyUsage();
    let protocolReason: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let submissions: ReviewSubmission[] = [];
      const git = new GitClient(this.options.execute, input.target.repositoryRoot, input.signal);
      const access = new ReviewTargetAccess(git, input.target);
      const tools = reviewerTools(input.target.repositoryRoot, access, (submission) => {
        submissions = [...submissions, structuredClone(submission)];
      });
      const session = await createChildSession({
        cwd: input.target.repositoryRoot,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        tools: ["read", "grep", "find", "ls", "review_target", "submit_review"],
        customTools: tools,
        contextFiles: this.options.contextFiles,
        // Never execute extension code from the mutable target. Role-model providers and
        // authentication were transferred from the outer runtime before the target was frozen.
        projectTrusted: false,
        extensionsEnabled: false,
      });
      try {
        const prompt = buildReviewerPrompt({ ...input, protocolRetryReason: protocolReason });
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
        const changed =
          input.target.type === "folder"
            ? undefined
            : await Promise.all([
                getTargetDiff(git, input.target, 0),
                getChangedFiles(git, input.target),
              ]);
        const submission = await validateReviewerResult(submissions[0], {
          target: input.target,
          pass: input.pass,
          changedLines: changed ? parseChangedLines(changed[0], changed[1]) : undefined,
          maxFindingsBytes: fixerFindingsByteBudget(this.options.fixerContextWindow),
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
