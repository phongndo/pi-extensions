import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
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
import { normalizeRepositoryPath, pathIsInScope } from "./git.ts";
import { createRepositoryInspectionTools } from "./inspection-tools.ts";
import {
  lstatIfExists,
  nearbyGitMetadataRealPaths,
  repositoryPathHasGitMetadataComponent,
  resolvedPathHasGitMetadataComponent,
  resolvedPathIsWithin,
  type GitMetadataPathCache,
} from "./path-safety.ts";
import type {
  FindingLedgerEntry,
  FixSubmission,
  ReviewFinding,
  ReviewTargetSnapshot,
  UsageSummary,
  VerificationResult,
} from "./models.ts";
import { addUsage, emptyUsage } from "./models.ts";
import { buildFixerPrompt, FIXER_SYSTEM_PROMPT } from "./prompts.ts";
import {
  asFixSubmission,
  fixerInputByteBudget,
  fixSubmissionSchema,
  validateFixSubmission,
  type FixSubmissionInput,
} from "./protocol.ts";

const execFileAsync = promisify(execFile);

async function resolvedMutationPath(repositoryRoot: string, normalized: string): Promise<string> {
  let candidate = resolve(repositoryRoot, normalized);
  const missingSegments: string[] = [];
  while (!(await lstatIfExists(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    missingSegments.unshift(basename(candidate));
    candidate = parent;
  }
  return resolve(await realpath(candidate), ...missingSegments);
}

export async function snapshotIgnoredPaths(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await execFileAsync(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { cwd: repositoryRoot, encoding: "utf8", signal },
  );
  return result.stdout.split("\0").filter(Boolean);
}

function pathWasInitiallyIgnored(normalized: string, ignoredPaths: readonly string[]): boolean {
  return ignoredPaths.some((entry) => {
    if (!entry.endsWith("/")) return normalized === entry;
    const directory = entry.slice(0, -1);
    return normalized === directory || normalized.startsWith(entry);
  });
}

async function pathIsIgnored(repositoryRoot: string, normalized: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise, reject) => {
    execFile(
      "git",
      ["check-ignore", "--quiet", "--", normalized],
      { cwd: repositoryRoot },
      (error) => {
        if (!error) {
          resolvePromise(true);
        } else if (error.code === 1) {
          resolvePromise(false);
        } else {
          reject(new Error(`Could not check whether ${normalized} is ignored.`, { cause: error }));
        }
      },
    );
  });
}

async function retainUntrackedMutation(
  target: ReviewTargetSnapshot,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  if (target.type === "folder") return;
  const normalized = normalizeRepositoryPath(target.repositoryRoot, path);
  const tracked = await execFileAsync(
    "git",
    ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", normalized],
    { cwd: target.repositoryRoot, encoding: "utf8", signal },
  );
  if (tracked.stdout.length > 0) return;
  target.retainedUntrackedPaths = [
    ...new Set([...(target.retainedUntrackedPaths ?? []), normalized]),
  ].sort();
}

export async function assertMutationPath(
  target: ReviewTargetSnapshot,
  inputPath: string,
  initiallyIgnoredPaths: readonly string[] = [],
  signal?: AbortSignal,
  metadataCache: GitMetadataPathCache = new Map(),
): Promise<string> {
  const normalized = normalizeRepositoryPath(target.repositoryRoot, inputPath);
  if (normalized === ".")
    throw new Error("A fixer tool must target a file, not the repository root.");
  if (repositoryPathHasGitMetadataComponent(normalized)) {
    throw new Error(`Fixer tools may not modify Git metadata: ${normalized}`);
  }
  if (target.type === "folder" && !pathIsInScope(normalized, target.paths ?? [])) {
    throw new Error(`Folder review fixes may not modify ${normalized}.`);
  }

  // Resolve the target (or derive its destination from the closest existing
  // parent for a new file) before enforcing boundaries so symlinks cannot bypass them.
  const rootReal = await realpath(target.repositoryRoot);
  const candidateReal = await resolvedMutationPath(target.repositoryRoot, normalized);
  if (!resolvedPathIsWithin(rootReal, candidateReal)) {
    throw new Error(`Mutation path resolves outside the repository: ${normalized}`);
  }
  if (resolvedPathHasGitMetadataComponent(rootReal, candidateReal)) {
    throw new Error(`Fixer tools may not modify Git metadata: ${normalized}`);
  }

  const metadataPaths = await nearbyGitMetadataRealPaths(
    target.repositoryRoot,
    candidateReal,
    signal,
    metadataCache,
  );
  if (metadataPaths.some((metadataPath) => resolvedPathIsWithin(metadataPath, candidateReal))) {
    throw new Error(`Fixer tools may not modify Git metadata: ${normalized}`);
  }

  if (target.type !== "folder") {
    const resolvedRepositoryPath = relative(rootReal, candidateReal).split(sep).join("/") || ".";
    for (const path of new Set([normalized, resolvedRepositoryPath])) {
      if (
        pathWasInitiallyIgnored(path, initiallyIgnoredPaths) ||
        (await pathIsIgnored(target.repositoryRoot, path))
      ) {
        throw new Error(`Diff review fixes may not modify ignored path ${normalized}.`);
      }
    }
  }

  if (target.type === "folder") {
    const scopeReals = await Promise.all(
      (target.paths ?? []).map((scope) => realpath(resolve(target.repositoryRoot, scope))),
    );
    if (!scopeReals.some((scopeReal) => resolvedPathIsWithin(scopeReal, candidateReal))) {
      throw new Error(`Folder review fixes may not modify ${normalized} through a symlink.`);
    }
  }

  return `./${normalized}`;
}

export function fixerTools(
  target: ReviewTargetSnapshot,
  capture: (submission: FixSubmission) => void,
  initiallyIgnoredPaths: readonly string[] = [],
  metadataCache: GitMetadataPathCache = new Map(),
): ToolDefinition<any, any, any>[] {
  const root = target.repositoryRoot;
  const edit = createEditToolDefinition(root);
  const write = createWriteToolDefinition(root);

  const guardedEdit: typeof edit = {
    ...edit,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await assertMutationPath(
        target,
        params.path,
        initiallyIgnoredPaths,
        signal,
        metadataCache,
      );
      const result = await edit.execute(toolCallId, { ...params, path }, signal, onUpdate, context);
      await retainUntrackedMutation(target, path, signal);
      return result;
    },
  };
  const guardedWrite: typeof write = {
    ...write,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await assertMutationPath(
        target,
        params.path,
        initiallyIgnoredPaths,
        signal,
        metadataCache,
      );
      const result = await write.execute(
        toolCallId,
        { ...params, path },
        signal,
        onUpdate,
        context,
      );
      await retainUntrackedMutation(target, path, signal);
      return result;
    },
  };
  const submitFix = defineTool({
    name: "submit_fix",
    label: "Submit Fix",
    description: "Submit the final structured fixer progress report and terminate this fixer turn.",
    parameters: fixSubmissionSchema,
    async execute(_toolCallId, params: FixSubmissionInput) {
      capture(asFixSubmission(params));
      return {
        content: [{ type: "text" as const, text: `Fix report submitted: ${params.status}.` }],
        details: {},
        terminate: true,
      };
    },
  });

  return [
    ...createRepositoryInspectionTools(root, metadataCache),
    guardedEdit,
    guardedWrite,
    submitFix,
  ];
}

export class FixerProtocolError extends Error {
  override name = "FixerProtocolError";
}

export interface FixerRunInput {
  target: ReviewTargetSnapshot;
  findings: ReviewFinding[];
  verificationFailure?: VerificationResult;
  initiallyIgnoredPaths?: readonly string[];
  ledger: FindingLedgerEntry[];
  pass: number;
  signal?: AbortSignal;
  onUsage?: (usage: UsageSummary) => void;
}

export interface FixerRunOutput {
  submission: FixSubmission;
  usage: UsageSummary;
  protocolRetries: number;
}

export interface FixerRunner {
  fix(input: FixerRunInput): Promise<FixerRunOutput>;
  dispose(): Promise<void>;
}

export interface SdkFixerOptions {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  contextFiles: TrustedContextFile[];
  contextPolicy: "continuous" | "fresh";
}

export class SdkFixer implements FixerRunner {
  private session: AgentSession | undefined;
  private target: ReviewTargetSnapshot | undefined;
  private submissions: FixSubmission[] = [];
  private readonly metadataCache: GitMetadataPathCache = new Map();
  private readonly options: SdkFixerOptions;

  constructor(options: SdkFixerOptions) {
    this.options = options;
  }

  private async createSession(
    target: ReviewTargetSnapshot,
    initiallyIgnoredPaths: readonly string[],
  ): Promise<AgentSession> {
    this.target = target;
    return createChildSession({
      cwd: target.repositoryRoot,
      modelRuntime: this.options.modelRuntime,
      model: this.options.model,
      thinkingLevel: this.options.thinkingLevel,
      systemPrompt: FIXER_SYSTEM_PROMPT,
      tools: ["read", "edit", "write", "grep", "find", "ls", "submit_fix"],
      customTools: fixerTools(
        target,
        (submission) => {
          this.submissions = [...this.submissions, structuredClone(submission)];
        },
        initiallyIgnoredPaths,
        this.metadataCache,
      ),
      contextFiles: this.options.contextFiles,
      // Never execute extension code from the mutable target. Role-model providers and
      // authentication were transferred from the outer runtime before the target was frozen.
      projectTrusted: false,
      extensionsEnabled: false,
    });
  }

  private async disposeSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session) await disposeChildSession(session);
  }

  private async sessionFor(
    target: ReviewTargetSnapshot,
    initiallyIgnoredPaths: readonly string[],
  ): Promise<AgentSession> {
    if (this.options.contextPolicy === "fresh") {
      await this.disposeSession();
      this.session = await this.createSession(target, initiallyIgnoredPaths);
      return this.session;
    }
    if (!this.session) this.session = await this.createSession(target, initiallyIgnoredPaths);
    if (this.target?.repositoryRoot !== target.repositoryRoot) {
      throw new Error("Persistent fixer cannot change repository roots during a run.");
    }
    return this.session;
  }

  async fix(input: FixerRunInput): Promise<FixerRunOutput> {
    const initiallyIgnoredPaths =
      input.initiallyIgnoredPaths ??
      (input.target.type === "folder"
        ? []
        : await snapshotIgnoredPaths(input.target.repositoryRoot, input.signal));
    const usage = emptyUsage();
    let protocolReason: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // Verification and other host activity can create nested metadata between fixer turns.
      // Keep caching within one prompt only, and clear again before a protocol retry.
      this.metadataCache.clear();
      const session = await this.sessionFor(input.target, initiallyIgnoredPaths);
      this.submissions = [];
      try {
        const prompt = buildFixerPrompt(
          { ...input, protocolRetryReason: protocolReason },
          fixerInputByteBudget(this.options.model.contextWindow),
        );
        await promptChild(session, prompt, input.signal, (addition) => {
          addUsage(usage, addition);
          input.onUsage?.(addition);
        });
        if (this.submissions.length !== 1) {
          throw new Error(
            this.submissions.length === 0
              ? "Fixer did not call submit_fix."
              : "Fixer called submit_fix more than once.",
          );
        }
        const submission = validateFixSubmission(
          this.submissions[0],
          input.findings.map((finding) => finding.id),
        );
        if (this.options.contextPolicy === "fresh") await this.disposeSession();
        return { submission, usage, protocolRetries: attempt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const protocolError =
          message.includes("submit_fix") ||
          message.startsWith("Fix submission") ||
          message.startsWith("Fix status") ||
          message.startsWith("outcomes") ||
          message.startsWith("Unknown finding") ||
          message.startsWith("Duplicate fixer") ||
          message.startsWith("Fixer omitted") ||
          message.startsWith("checksRun") ||
          message.startsWith("summary");
        if (!protocolError || input.signal?.aborted) throw error;
        if (attempt === 1) throw new FixerProtocolError(message, { cause: error });
        protocolReason = message;
        if (this.options.contextPolicy === "fresh") await this.disposeSession();
      }
    }
    throw new Error("Fixer protocol failed after retry.");
  }

  async dispose(): Promise<void> {
    await this.disposeSession();
  }
}
