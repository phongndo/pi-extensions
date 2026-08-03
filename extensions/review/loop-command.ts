import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveRoleModels, type TrustedContextFile } from "./child-session.ts";
import { SdkFixer } from "./fixer.ts";
import {
  defaultBranch,
  GitClient,
  listLocalBranches,
  listRecentCommits,
  type ExecGit,
} from "./git.ts";
import { isInteractiveReviewActive } from "./interactive-review-state.ts";
import {
  REVIEW_MODES,
  type ReviewLoopResult,
  type ReviewLoopRunState,
  type ReviewMode,
  type ReviewTargetRequest,
} from "./models.ts";
import { runReviewLoop } from "./orchestrator.ts";
import {
  registerRenderers,
  resultContextContent,
  sanitizeTerminalText,
  REVIEW_LOOP_RESULT_TYPE,
  REVIEW_LOOP_RUN_STATE_TYPE,
} from "./renderers.ts";
import { SdkReviewer } from "./reviewer.ts";
import { loadSettings } from "./settings.ts";
import {
  findProjectReviewGuidelinesAncestor,
  getSmartDefault,
  loadProjectReviewGuidelines,
  loadTargetContextFiles,
  resolveTarget,
} from "./targets.ts";
import {
  showLoopProgress,
  showReviewLoopSettings,
  showSearchableSelection,
  showTargetSelector,
  type TargetChoice,
} from "./ui.ts";

const USAGE =
  "Usage: /loop-review [uncommitted | branch <name> | commit <sha> | pr <number-or-url> | folder <paths...> | settings] [--mode <standard|adversarial|security|migration>] [--extra <instruction>]";

function terminalErrorText(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error));
}

export interface ParsedReviewLoopArgs {
  action: "run" | "settings";
  target?: ReviewTargetRequest;
  reviewMode?: ReviewMode;
  extraInstruction?: string;
}

export function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (
        quote === '"' &&
        character === "\\" &&
        index + 1 < value.length &&
        (value[index + 1] === '"' || value[index + 1] === "\\")
      ) {
        current += value[index + 1]!;
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("Unterminated quote in review arguments.");
  if (current) tokens.push(current);
  return tokens;
}

function reviewModeFromOption(value: string): ReviewMode {
  const normalized = value.trim().toLowerCase();
  if (!REVIEW_MODES.includes(normalized as ReviewMode)) {
    throw new Error(`Unknown review mode: ${value}. Choose ${REVIEW_MODES.join(", ")}.`);
  }
  return normalized as ReviewMode;
}

export function parseReviewLoopArgs(value: string): ParsedReviewLoopArgs {
  const raw = tokenizeArgs(value.trim());
  const positional: string[] = [];
  let extraInstruction: string | undefined;
  let reviewMode: ReviewMode | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index]!;
    if (token === "--extra") {
      const instruction = raw[index + 1];
      if (!instruction) throw new Error("Missing value for --extra.");
      if (extraInstruction) throw new Error("--extra may be specified only once.");
      extraInstruction = instruction.trim() || undefined;
      index += 1;
    } else if (token.startsWith("--extra=")) {
      if (extraInstruction) throw new Error("--extra may be specified only once.");
      extraInstruction = token.slice("--extra=".length).trim() || undefined;
      if (!extraInstruction) throw new Error("Missing value for --extra.");
    } else if (token === "--mode") {
      const mode = raw[index + 1];
      if (!mode) throw new Error("Missing value for --mode.");
      if (reviewMode) throw new Error("--mode may be specified only once.");
      reviewMode = reviewModeFromOption(mode);
      index += 1;
    } else if (token.startsWith("--mode=")) {
      if (reviewMode) throw new Error("--mode may be specified only once.");
      const mode = token.slice("--mode=".length);
      if (!mode.trim()) throw new Error("Missing value for --mode.");
      reviewMode = reviewModeFromOption(mode);
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }

  if (positional.length === 0) return { action: "run", reviewMode, extraInstruction };
  const subcommand = positional[0]?.toLowerCase();
  if (subcommand === "settings" || subcommand === "setting") {
    if (positional.length !== 1 || extraInstruction || reviewMode)
      throw new Error(`${subcommand} does not accept target options.`);
    return { action: "settings" };
  }
  switch (subcommand) {
    case "uncommitted":
      if (positional.length !== 1)
        throw new Error("uncommitted does not accept positional arguments.");
      return {
        action: "run",
        target: { type: "uncommitted" },
        reviewMode,
        extraInstruction,
      };
    case "branch":
      if (positional.length !== 2) throw new Error("branch requires exactly one branch name.");
      return {
        action: "run",
        target: { type: "baseBranch", branch: positional[1] as string },
        reviewMode,
        extraInstruction,
      };
    case "commit":
      if (positional.length < 2) throw new Error("commit requires a revision.");
      return {
        action: "run",
        target: {
          type: "commit",
          sha: positional[1] as string,
          title: positional.slice(2).join(" ") || undefined,
        },
        reviewMode,
        extraInstruction,
      };
    case "pr":
      if (positional.length !== 2) throw new Error("pr requires exactly one number or URL.");
      return {
        action: "run",
        target: { type: "pullRequest", reference: positional[1] as string },
        reviewMode,
        extraInstruction,
      };
    case "folder":
      if (positional.length < 2) throw new Error("folder requires at least one path.");
      return {
        action: "run",
        target: { type: "folder", paths: positional.slice(1) },
        reviewMode,
        extraInstruction,
      };
    default:
      throw new Error(`Unknown review target: ${positional[0]}. ${USAGE}`);
  }
}

const COMPLETIONS: AutocompleteItem[] = [
  {
    value: "uncommitted",
    label: "uncommitted",
    description: "review unstaged and untracked changes",
  },
  { value: "branch ", label: "branch", description: "review against a base branch" },
  { value: "commit ", label: "commit", description: "review the current HEAD commit" },
  { value: "pr ", label: "pr", description: "review a GitHub pull request" },
  { value: "folder ", label: "folder", description: "review paths as a snapshot" },
  {
    value: "settings",
    label: "settings",
    description: "configure review agents, models, and convergence",
  },
];

export function argumentCompletions(prefix: string): AutocompleteItem[] | null {
  if (prefix.trim().includes(" ")) return null;
  const normalized = prefix.trimStart().toLowerCase();
  const matches = COMPLETIONS.filter((item) => item.value.trim().startsWith(normalized));
  return matches.length > 0 ? matches : null;
}

export function commitSelectionItems(
  commits: readonly { sha: string; title: string }[],
): SelectItem[] {
  return commits.map((commit, index) => ({
    value: commit.sha,
    label: sanitizeTerminalText(`${commit.sha.slice(0, 12)} ${commit.title}`),
    description: index === 0 ? "HEAD (supported)" : "historical (not supported yet)",
  }));
}

async function requestFromChoice(
  choice: TargetChoice,
  ctx: ExtensionCommandContext,
  git: GitClient,
): Promise<ReviewTargetRequest | undefined> {
  switch (choice) {
    case "uncommitted":
      return { type: "uncommitted" };
    case "baseBranch": {
      const current = await git.branch();
      const preferred = await defaultBranch(git);
      const branches = (await listLocalBranches(git))
        .filter((branch) => branch !== current)
        .sort((left, right) =>
          left === preferred ? -1 : right === preferred ? 1 : left.localeCompare(right),
        );
      if (branches.length === 0)
        throw new Error("No other local branches are available as a review base.");
      const selected = await showSearchableSelection(
        ctx,
        "Select a base branch",
        branches.map(
          (branch) =>
            ({
              value: branch,
              label: sanitizeTerminalText(branch),
              description: branch === preferred ? "default branch" : undefined,
            }) satisfies SelectItem,
        ),
      );
      return selected ? { type: "baseBranch", branch: selected } : undefined;
    }
    case "commit": {
      const commits = await listRecentCommits(git);
      if (commits.length === 0) throw new Error("No commits are available to review.");
      const selected = await showSearchableSelection(
        ctx,
        "Select the current HEAD commit",
        commitSelectionItems(commits),
      );
      const commit = commits.find((candidate) => candidate.sha === selected);
      return commit ? { type: "commit", sha: commit.sha, title: commit.title } : undefined;
    }
    case "pullRequest": {
      const reference = await ctx.ui.editor("Pull request number or GitHub URL", "");
      return reference?.trim() ? { type: "pullRequest", reference: reference.trim() } : undefined;
    }
    case "folder": {
      const value = await ctx.ui.editor(
        "Folders/files to review (space-separated or one per line)",
        ".",
      );
      if (!value?.trim()) return undefined;
      const paths = tokenizeArgs(value);
      return paths.length > 0 ? { type: "folder", paths } : undefined;
    }
  }
}

function contextFiles(ctx: ExtensionCommandContext): TrustedContextFile[] {
  return (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function latestRunState(ctx: ExtensionContext): ReviewLoopRunState | undefined {
  let latest: ReviewLoopRunState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === REVIEW_LOOP_RUN_STATE_TYPE) {
      latest = entry.data as ReviewLoopRunState | undefined;
    }
  }
  return latest;
}

export async function openReviewSettings(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Review settings require TUI mode.", "error");
    return;
  }

  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    ctx.ui.notify(terminalErrorText(error), "error");
    return;
  }

  await showReviewLoopSettings(ctx, settings).catch((error) => {
    ctx.ui.notify(terminalErrorText(error), "error");
  });
}

export function registerReviewSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("settings-review", {
    description: "Configure Review Loop mode, agent count, models, and convergence",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /settings-review", "error");
        return;
      }
      await openReviewSettings(ctx);
    },
  });
}

export function registerReviewLoopCommand(pi: ExtensionAPI): void {
  registerRenderers(pi);
  let running = false;
  let activeController: AbortController | undefined;

  pi.on("session_start", (_event, ctx) => {
    const previous = latestRunState(ctx);
    if (previous && !previous.terminalStatus) {
      pi.appendEntry<ReviewLoopRunState>(REVIEW_LOOP_RUN_STATE_TYPE, {
        ...previous,
        updatedAt: new Date().toISOString(),
        phase: "terminal",
        terminalStatus: "interrupted",
      });
    }
  });

  pi.on("session_shutdown", () => {
    activeController?.abort();
  });

  pi.registerCommand("loop-review", {
    description: "Run standard or parallel specialized review/fix loops until clean or bounded",
    getArgumentCompletions: argumentCompletions,
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/loop-review requires TUI mode.", "error");
        return;
      }

      let parsed: ParsedReviewLoopArgs;
      try {
        parsed = parseReviewLoopArgs(args);
      } catch (error) {
        ctx.ui.notify(`${terminalErrorText(error)}\n${USAGE}`, "error");
        return;
      }

      // Settings routing deliberately precedes Git checks.
      if (parsed.action === "settings") {
        await openReviewSettings(ctx);
        return;
      }
      if (isInteractiveReviewActive(ctx)) {
        ctx.ui.notify(
          "Cannot start a repair loop during a read-only interactive review. Use /end-review first.",
          "error",
        );
        return;
      }
      if (running) {
        ctx.ui.notify("A review loop is already running.", "warning");
        return;
      }

      let settings;
      try {
        settings = await loadSettings();
        if (parsed.reviewMode) settings.reviewMode = parsed.reviewMode;
      } catch (error) {
        ctx.ui.notify(terminalErrorText(error), "error");
        return;
      }

      const reviewerToolNames = pi.getActiveTools();
      const execute: ExecGit = (command, commandArgs, commandOptions) =>
        pi.exec(command, commandArgs, commandOptions);
      const initialGit = new GitClient(execute, ctx.cwd);
      let repositoryRoot: string;
      try {
        repositoryRoot = await initialGit.repositoryRoot();
      } catch {
        ctx.ui.notify("Review loop must run inside a Git repository.", "error");
        return;
      }
      const git = new GitClient(execute, repositoryRoot);

      let request = parsed.target;
      try {
        if (!request) {
          const smartDefault = await getSmartDefault(execute, repositoryRoot);
          const choice = await showTargetSelector(ctx, smartDefault);
          if (!choice) return;
          request = await requestFromChoice(choice, ctx, git);
        }
      } catch (error) {
        ctx.ui.notify(terminalErrorText(error), "error");
        return;
      }
      if (!request) return;

      running = true;
      try {
        const outerContextFiles = contextFiles(ctx);
        const projectTrusted = ctx.isProjectTrusted();
        // Discover only an ancestor-owned source before a PR checkout can replace the worktree.
        // Repository-owned guidelines are loaded from the frozen target baseline below.
        const guidelineAncestor = await findProjectReviewGuidelinesAncestor(
          repositoryRoot,
          projectTrusted,
        );
        const result = await showLoopProgress(
          ctx,
          async (signal, update) => {
            update({
              phase: "resolving-target",
              pass: 0,
              maximumPasses: settings.maximumPasses,
              detail: "preflighting reviewer and fixer models",
            });
            // Model/auth preflight happens before PR checkout or any fixer edit.
            const models = await resolveRoleModels({
              settings,
              currentModel: ctx.model,
              currentThinking: ctx.thinkingLevel as ModelThinkingLevel | undefined,
              outerRegistry: ctx.modelRegistry,
              signal,
            });
            update({
              phase: "resolving-target",
              pass: 0,
              maximumPasses: settings.maximumPasses,
              detail: "freezing review target",
            });
            const target = await resolveTarget(request, {
              cwd: repositoryRoot,
              execute,
              signal,
              notify: (message) =>
                update({
                  phase: "resolving-target",
                  pass: 0,
                  maximumPasses: settings.maximumPasses,
                  detail: sanitizeTerminalText(message),
                }),
            });
            const projectGuidelines = await loadProjectReviewGuidelines({
              target,
              execute,
              projectTrusted,
              ancestorDirectory: guidelineAncestor,
              signal,
            });
            const trustedFiles = await loadTargetContextFiles({
              target,
              execute,
              outerContextFiles,
              projectTrusted,
              signal,
            });
            const reviewer = new SdkReviewer({
              execute,
              modelRuntime: models.runtime,
              model: models.reviewerModel,
              thinkingLevel: models.reviewer.thinkingLevel,
              contextFiles: trustedFiles,
              fixerContextWindow: models.fixerModel.contextWindow,
              inheritedToolNames: reviewerToolNames,
            });
            return runReviewLoop({
              target,
              settings,
              models,
              reviewer,
              createFixer: () =>
                new SdkFixer({
                  modelRuntime: models.runtime,
                  model: models.fixerModel,
                  thinkingLevel: models.fixer.thinkingLevel,
                  contextFiles: trustedFiles,
                  contextPolicy: settings.fixerContext,
                }),
              host: {
                execute,
                persist: (state) => pi.appendEntry(REVIEW_LOOP_RUN_STATE_TYPE, state),
                progress: update,
              },
              reviewInstructions: settings.reviewInstructions,
              extraInstruction: parsed.extraInstruction,
              projectGuidelines,
              signal,
            });
          },
          (controller) => {
            activeController = controller;
          },
        );
        pi.sendMessage<ReviewLoopResult>({
          customType: REVIEW_LOOP_RESULT_TYPE,
          content: resultContextContent(result),
          display: true,
          details: result,
        });
      } catch (error) {
        ctx.ui.notify(terminalErrorText(error), "error");
      } finally {
        activeController = undefined;
        running = false;
      }
    },
  });
}
