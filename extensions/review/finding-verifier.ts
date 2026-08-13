import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSession,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createChildSession,
  disposeChildSession,
  promptChild,
  type TrustedContextFile,
} from "./child-session.ts";
import { getChangedFiles, GitClient, type ExecGit } from "./git.ts";
import type { FindingVerificationSubmission, ReviewFinding, UsageSummary } from "./models.ts";
import { addUsage, emptyUsage } from "./models.ts";
import {
  buildFindingVerificationPrompt,
  FINDING_VERIFIER_SYSTEM_PROMPT,
  reviewerPathInventoryByteBudget,
  ReviewPromptBudgetError,
  type FindingVerificationPromptOptions,
} from "./prompts.ts";
import {
  asFindingVerificationSubmission,
  findingVerificationSubmissionSchemaForMaxFindings,
  validateFindingVerificationSubmission,
  type FindingVerificationSubmissionInput,
} from "./protocol.ts";
import { createReviewerPassCache, type ReviewerPassCache } from "./reviewer.ts";

const REQUIRED_FINDING_VERIFIER_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "submit_finding_verification",
] as const;

export function findingVerifierActiveTools(inherited: readonly string[]): string[] {
  return [
    ...new Set([
      ...inherited.filter((name) => name !== "edit" && name !== "write"),
      ...REQUIRED_FINDING_VERIFIER_TOOLS,
    ]),
  ];
}

function findingVerifierTools(
  capture: (submission: FindingVerificationSubmission) => void,
  maxFindings: number,
): ToolDefinition<any, any, any>[] {
  const submitVerification = defineTool({
    name: "submit_finding_verification",
    label: "Submit Finding Verification",
    description:
      "Submit the final independent classification of every candidate finding and terminate this verification run.",
    parameters: findingVerificationSubmissionSchemaForMaxFindings(maxFindings),
    async execute(_toolCallId, params: FindingVerificationSubmissionInput) {
      capture(asFindingVerificationSubmission(params));
      return {
        content: [
          {
            type: "text" as const,
            text: `Finding verification submitted with ${params.outcomes.length} outcome(s).`,
          },
        ],
        details: {},
        terminate: true,
      };
    },
  });
  return [submitVerification];
}

export class FindingVerificationProtocolError extends Error {
  override name = "FindingVerificationProtocolError";
}

export interface FindingVerifierRunInput extends FindingVerificationPromptOptions {
  passCache?: ReviewerPassCache;
  signal?: AbortSignal;
  onUsage?: (usage: UsageSummary) => void;
}

export interface FindingVerifierRunOutput {
  submission: FindingVerificationSubmission;
  usage: UsageSummary;
  protocolRetries: number;
}

export interface FindingVerifierRunner {
  verify(input: FindingVerifierRunInput): Promise<FindingVerifierRunOutput>;
}

export interface SdkFindingVerifierOptions {
  execute: ExecGit;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  contextFiles: TrustedContextFile[];
  inheritedToolNames?: string[];
}

const FINDING_VERIFIER_REQUEST_FRAMING_TOKENS = 1_024;
const FINDING_VERIFIER_MIN_RESPONSE_TOKENS = 4 * 1_024;
const FINDING_VERIFIER_RESPONSE_TOKENS_PER_FINDING = 512;

function findingVerifierThinkingTokenReserve(
  session: AgentSession,
  thinkingLevel: ModelThinkingLevel,
): number {
  const configured = session.settingsManager.getThinkingBudgets();
  switch (thinkingLevel) {
    case "off":
      return 0;
    case "minimal":
      return configured?.minimal ?? 1_024;
    case "low":
      return configured?.low ?? 2_048;
    case "medium":
      return configured?.medium ?? 8_192;
    case "high":
    case "xhigh":
    case "max":
      return configured?.high ?? 16_384;
  }
}

function findingVerifierOutputTokenReserve(
  session: AgentSession,
  modelMaxTokens: number,
  thinkingLevel: ModelThinkingLevel,
  findingCount: number,
): number {
  if (!Number.isFinite(modelMaxTokens) || modelMaxTokens <= 0) {
    throw new Error("Finding verifier model output limit must be a positive number.");
  }
  const responseTokens = Math.max(
    FINDING_VERIFIER_MIN_RESPONSE_TOKENS,
    1_024 + findingCount * FINDING_VERIFIER_RESPONSE_TOKENS_PER_FINDING,
  );
  return Math.min(
    modelMaxTokens,
    responseTokens + findingVerifierThinkingTokenReserve(session, thinkingLevel),
  );
}

/**
 * UTF-8 bytes are a conservative token bound even for byte-dense, model-produced strings. Include
 * the effective session prompt so context files and tool prompt additions are covered, and
 * serialize every active tool schema to account for provider request overhead.
 */
function findingVerifierInputTokenUpperBound(session: AgentSession, prompt: string): number {
  const tools = session.getActiveToolNames().map((name) => {
    const definition = session.getToolDefinition(name);
    if (!definition) throw new Error(`Could not budget active finding-verifier tool: ${name}.`);
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    };
  });
  const serializedRequest = JSON.stringify({
    systemPrompt: session.systemPrompt,
    tools,
    messages: [{ role: "user", content: prompt }],
  });
  return Buffer.byteLength(serializedRequest, "utf8") + FINDING_VERIFIER_REQUEST_FRAMING_TOKENS;
}

export class SdkFindingVerifier implements FindingVerifierRunner {
  private readonly options: SdkFindingVerifierOptions;

  constructor(options: SdkFindingVerifierOptions) {
    this.options = options;
  }

  async verify(input: FindingVerifierRunInput): Promise<FindingVerifierRunOutput> {
    if (input.findings.length === 0) {
      throw new Error("Finding verifier requires at least one candidate finding.");
    }
    const usage = emptyUsage();
    const passCache = input.passCache ?? createReviewerPassCache();
    let protocolReason: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let submissions: FindingVerificationSubmission[] = [];
      const git = new GitClient(this.options.execute, input.target.repositoryRoot, input.signal);
      const changedFiles = await passCache.get("changedFiles", () =>
        getChangedFiles(git, input.target),
      );
      const tools = findingVerifierTools((submission) => {
        submissions = [...submissions, structuredClone(submission)];
      }, input.findings.length);
      const activeTools = findingVerifierActiveTools(this.options.inheritedToolNames ?? []);
      const session = await createChildSession({
        cwd: input.target.repositoryRoot,
        modelRuntime: this.options.modelRuntime,
        model: this.options.model,
        thinkingLevel: this.options.thinkingLevel,
        systemPrompt: FINDING_VERIFIER_SYSTEM_PROMPT,
        tools: activeTools,
        customTools: tools,
        contextFiles: this.options.contextFiles,
        // Match reviewer isolation: trusted global extensions are available, project code is not.
        projectTrusted: false,
        extensionsEnabled: true,
      });
      try {
        const prompt = buildFindingVerificationPrompt(
          {
            ...input,
            changedFiles,
            protocolRetryReason: protocolReason,
          },
          reviewerPathInventoryByteBudget(this.options.model.contextWindow),
        );
        const inputTokenUpperBound = findingVerifierInputTokenUpperBound(session, prompt);
        const outputTokenReserve = findingVerifierOutputTokenReserve(
          session,
          this.options.model.maxTokens,
          this.options.thinkingLevel,
          input.findings.length,
        );
        const totalTokenBudget = inputTokenUpperBound + outputTokenReserve;
        if (totalTokenBudget > this.options.model.contextWindow) {
          throw new ReviewPromptBudgetError(
            `Finding-verifier request exceeds its context budget (${inputTokenUpperBound} conservative input tokens + ${outputTokenReserve} reserved output tokens > ${this.options.model.contextWindow} tokens). Review a smaller target or use a model with a larger context window.`,
          );
        }
        await promptChild(session, prompt, input.signal, (addition) => {
          addUsage(usage, addition);
          input.onUsage?.(addition);
        });
        if (submissions.length !== 1) {
          throw new Error(
            submissions.length === 0
              ? "Finding verifier did not call submit_finding_verification."
              : "Finding verifier called submit_finding_verification more than once.",
          );
        }
        let submission: FindingVerificationSubmission;
        try {
          submission = validateFindingVerificationSubmission(
            submissions[0],
            input.findings.map((finding: ReviewFinding) => finding.id),
          );
        } catch (error) {
          throw new FindingVerificationProtocolError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        return { submission, usage, protocolRetries: attempt };
      } catch (error) {
        if (error instanceof ReviewPromptBudgetError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const isProtocolError =
          error instanceof FindingVerificationProtocolError ||
          message.includes("submit_finding_verification") ||
          message.startsWith("Finding verification submission") ||
          message.startsWith("Finding verifier omitted") ||
          message.startsWith("Unknown finding ID") ||
          message.startsWith("Duplicate finding verification") ||
          message.startsWith("outcomes") ||
          message.startsWith("summary");
        if (!isProtocolError || input.signal?.aborted) throw error;
        if (attempt === 1) {
          if (error instanceof FindingVerificationProtocolError) throw error;
          throw new FindingVerificationProtocolError(message, { cause: error });
        }
        protocolReason = message;
      } finally {
        await disposeChildSession(session);
      }
    }
    throw new FindingVerificationProtocolError("Finding-verifier protocol failed after retry.");
  }
}
