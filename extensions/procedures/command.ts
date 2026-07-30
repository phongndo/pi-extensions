import { readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  StringEnum,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  truncateHead,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { generateProcedure } from "./author.ts";
import type {
  AuthoredProcedure,
  ProcedureDefinition,
  ProcedureModelChoice,
  ProcedureRun,
} from "./models.ts";
import { PROCEDURE_DEFAULT_MODEL, PROCEDURE_MODEL_ALLOWLIST, READ_ONLY_TOOLS } from "./models.ts";
import { showAuthoringProgress, showMonitor } from "./monitor.ts";
import { activeRuns, type ProcedureRegistry } from "./runner.ts";
import {
  normalizeProcedureName,
  terminalText,
  validateProcedureSource,
  validateProcedureTools,
} from "./security.ts";
import {
  createProcedureModelEnvironment,
  PiAgentExecutor,
  type ProcedureContextFile,
} from "./sessions.ts";
import type { ProcedureDefinitionStore, ProcedureRunStore } from "./store.ts";

const USAGE =
  "Usage: /proc <goal> | /proc create <goal> | /proc run <name> [goal] | /proc save <run-id> [name] | /proc pause <run-id> | /proc resume <run-id> | /proc stop <run-id> | /proc restart <run-id>";
const RUN_ENTRY_TYPE = "procedure-run";
const PROCEDURE_MODELS = new Set<string>(PROCEDURE_MODEL_ALLOWLIST);
const PROCEDURE_MODEL_PRIORITY = new Map<string, number>(
  PROCEDURE_MODEL_ALLOWLIST.map((reference, index) => [reference, index]),
);

export interface ProcedureService {
  definitions: ProcedureDefinitionStore;
  runs: ProcedureRunStore;
  registry: ProcedureRegistry;
}

function tokens(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < value.length) {
        current += value[++index];
      } else current += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else current += character;
  }
  if (quote) throw new Error("Unterminated quote in /proc arguments.");
  if (current) result.push(current);
  return result;
}

function contextFiles(ctx: ExtensionCommandContext): ProcedureContextFile[] {
  return (ctx.getSystemPromptOptions().contextFiles ?? []).map((file) => ({
    path: file.path,
    content: file.content,
  }));
}

function modelChoices(ctx: ExtensionCommandContext): ProcedureModelChoice[] {
  const scopedModels = (
    ctx as ExtensionCommandContext & {
      scopedModels?: readonly { model: Model<Api>; thinkingLevel?: ModelThinkingLevel }[];
    }
  ).scopedModels;
  const scoped = (scopedModels?.length ?? 0) > 0;
  const entries: Array<{ model: Model<Api>; thinkingLevel?: ModelThinkingLevel }> = scoped
    ? [...(scopedModels ?? [])]
    : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
  const selectedModel = ctx.model;
  if (
    !scoped &&
    selectedModel &&
    !entries.some(
      (entry) =>
        entry.model.provider === selectedModel.provider && entry.model.id === selectedModel.id,
    )
  ) {
    entries.unshift({ model: selectedModel });
  }
  const current = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : undefined;
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const reference = `${entry.model.provider}/${entry.model.id}`;
      if (!PROCEDURE_MODELS.has(reference) || seen.has(reference)) return false;
      seen.add(reference);
      return true;
    })
    .sort(
      (left, right) =>
        (PROCEDURE_MODEL_PRIORITY.get(`${left.model.provider}/${left.model.id}`) ?? 0) -
        (PROCEDURE_MODEL_PRIORITY.get(`${right.model.provider}/${right.model.id}`) ?? 0),
    )
    .map((entry) => {
      const model = entry.model;
      const pinnedThinking = entry.thinkingLevel;
      return {
        reference: `${model.provider}/${model.id}`,
        name: model.name || model.id,
        thinkingLevels: pinnedThinking ? [pinnedThinking] : getSupportedThinkingLevels(model),
        pinnedThinking,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        input: [...model.input],
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
        },
        current: `${model.provider}/${model.id}` === current,
      };
    });
}

function defaultProcedureModel(
  ctx: ExtensionCommandContext,
  choices: readonly ProcedureModelChoice[],
): Model<Api> {
  const choice =
    choices.find((candidate) => candidate.current) ??
    choices.find((candidate) => candidate.reference === PROCEDURE_DEFAULT_MODEL) ??
    choices[0];
  if (!choice) {
    throw new Error(
      `No approved procedure model is available. Authenticate and enable one of: ${PROCEDURE_MODEL_ALLOWLIST.join(", ")}.`,
    );
  }
  const separator = choice.reference.indexOf("/");
  const model = ctx.modelRegistry.find(
    choice.reference.slice(0, separator),
    choice.reference.slice(separator + 1),
  );
  if (!model) throw new Error(`Procedure model ${choice.reference} is no longer available.`);
  return model;
}

function runSummary(run: ProcedureRun): Record<string, unknown> {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    phase: run.phase,
    tasks: run.tasks.length,
    procedureName: run.procedureName,
    updatedAt: run.updatedAt,
    error: run.error,
  };
}

function transientDefinition(
  authored: AuthoredProcedure,
  goal: string,
  sourcePath: string,
): ProcedureDefinition {
  return {
    version: 1,
    name: normalizeProcedureName(authored.name),
    title: authored.title.trim().slice(0, 160),
    description: authored.description.trim().slice(0, 1_000),
    goal: goal.trim().slice(0, 16_000),
    sourceFile: basename(sourcePath),
    allowedTools: validateProcedureTools([...READ_ONLY_TOOLS, ...authored.requiredTools]),
    createdAt: new Date().toISOString(),
  };
}

async function launch(
  ctx: ExtensionCommandContext,
  service: ProcedureService,
  definition: ProcedureDefinition,
  source: string,
  goal: string,
): Promise<ProcedureRun> {
  const sourcePath = await service.runs.writeSource(source);
  const choices = modelChoices(ctx);
  const environment = await createProcedureModelEnvironment(
    ctx.modelRegistry,
    defaultProcedureModel(ctx, choices),
  );
  const thinkingLevel = clampThinkingLevel(
    environment.model,
    (ctx.thinkingLevel ?? "medium") as ModelThinkingLevel,
  );
  const runDefinition = { ...definition, goal };
  const run = service.registry.start({
    definition: runDefinition,
    source,
    sourcePath,
    input: { goal },
    cwd: ctx.cwd,
    model: `${environment.model.provider}/${environment.model.id}`,
    thinkingLevel,
    executor: new PiAgentExecutor({
      cwd: ctx.cwd,
      runtime: environment.runtime,
      model: environment.model,
      thinkingLevel,
      contextFiles: contextFiles(ctx),
      modelRegistry: ctx.modelRegistry,
      availableModels: new Map(
        choices.map((choice) => [
          choice.reference,
          {
            thinkingLevels: choice.thinkingLevels,
            pinnedThinking: choice.pinnedThinking,
          },
        ]),
      ),
    }),
  });
  ctx.ui.notify(
    `Started ${terminalText(run.title, 160)} (${run.id.slice(0, 8)}) in the background. Continue chatting normally; use /monitor when needed.`,
    "info",
  );
  return run;
}

/**
 * Read source retained by a historical run.
 * Current runs snapshot into the private run store; older `/proc run` launches
 * pointed at the project-local saved procedure file and are accepted as legacy.
 */
async function readRetainedRunSource(
  service: ProcedureService,
  sourcePath: string,
): Promise<string> {
  if (!basename(sourcePath).endsWith(".proc.js")) {
    throw new Error("The previous run does not reference a valid procedure source file.");
  }
  const candidate = resolve(sourcePath);
  const privateRoot = resolve(service.runs.directory, "sources");
  const fromPrivate = relative(privateRoot, candidate);
  if (fromPrivate !== ".." && !fromPrivate.startsWith(`..${sep}`)) {
    return service.runs.readSource(sourcePath);
  }
  // Legacy path: `.pi/procedures/<name>.proc.js` from pre-snapshot `/proc run`.
  const legacyRoot = resolve(service.definitions.directory);
  const fromLegacy = relative(legacyRoot, candidate);
  if (
    fromLegacy === ".." ||
    fromLegacy.startsWith(`..${sep}`) ||
    fromLegacy !== basename(fromLegacy)
  ) {
    throw new Error(
      "The previous run does not retain a usable procedure source. Rerun it with /proc run or /proc <goal>.",
    );
  }
  const source = await readFile(candidate, "utf8");
  validateProcedureSource(source);
  return source;
}

async function restartRun(
  ctx: ExtensionCommandContext,
  service: ProcedureService,
  runId: string,
): Promise<ProcedureRun> {
  if (!ctx.isProjectTrusted()) {
    throw new Error("Trust this project before creating or running procedures.");
  }
  const previous = service.registry.get(runId);
  if (!previous) throw new Error(`No procedure run matches ${runId}.`);
  if (activeRuns([previous]).length > 0) {
    throw new Error(
      `Procedure ${previous.id.slice(0, 8)} is still active. Use resume for a paused run or stop it before restarting.`,
    );
  }
  const source = await readRetainedRunSource(service, previous.sourcePath);
  const definition: ProcedureDefinition = {
    version: 1,
    name: previous.procedureName,
    title: previous.title,
    description: previous.description,
    goal: previous.goal,
    sourceFile: basename(previous.sourcePath),
    allowedTools: [...previous.allowedTools],
    createdAt: previous.createdAt,
  };
  return launch(ctx, service, definition, source, previous.goal);
}

async function createAndLaunch(
  ctx: ExtensionCommandContext,
  service: ProcedureService,
  initialGoal: string,
): Promise<void> {
  const goal = initialGoal.trim() || (await ctx.ui.editor("Procedure goal", ""))?.trim();
  if (!goal) return;
  const choices = modelChoices(ctx);
  const authorModel = defaultProcedureModel(ctx, choices);
  const generated = await showAuthoringProgress(ctx, async (signal, activity) => {
    activity(`preflighting approved model ${authorModel.provider}/${authorModel.id}`);
    const environment = await createProcedureModelEnvironment(
      ctx.modelRegistry,
      authorModel,
      signal,
    );
    const thinkingLevel = clampThinkingLevel(
      environment.model,
      (ctx.thinkingLevel ?? "medium") as ModelThinkingLevel,
    );
    const authored = await generateProcedure({
      cwd: ctx.cwd,
      goal,
      runtime: environment.runtime,
      model: environment.model,
      thinkingLevel,
      contextFiles: contextFiles(ctx),
      availableModels: choices,
      signal,
      onActivity: activity,
    });
    return { environment, authored, thinkingLevel };
  });
  const reviewedSource = await ctx.ui.editor(
    `Review procedure source · ${terminalText(generated.authored.title, 160)}`,
    generated.authored.source,
  );
  if (reviewedSource === undefined) return;
  validateProcedureSource(reviewedSource);
  const authored: AuthoredProcedure = { ...generated.authored, source: reviewedSource.trim() };
  const sourcePath = await service.runs.writeSource(authored.source);
  const definition = transientDefinition(authored, goal, sourcePath);
  const thinkingLevel = generated.thinkingLevel;
  const run = service.registry.start({
    definition,
    source: authored.source,
    sourcePath,
    input: { goal },
    cwd: ctx.cwd,
    model: `${generated.environment.model.provider}/${generated.environment.model.id}`,
    thinkingLevel,
    executor: new PiAgentExecutor({
      cwd: ctx.cwd,
      runtime: generated.environment.runtime,
      model: generated.environment.model,
      thinkingLevel,
      contextFiles: contextFiles(ctx),
      modelRegistry: ctx.modelRegistry,
      availableModels: new Map(
        choices.map((choice) => [
          choice.reference,
          {
            thinkingLevels: choice.thinkingLevels,
            pinnedThinking: choice.pinnedThinking,
          },
        ]),
      ),
    }),
  });
  ctx.ui.notify(
    `Started ephemeral run ${run.id.slice(0, 8)} in the background. Continue chatting normally; use /monitor, and /proc save ${run.id.slice(0, 8)} to keep it.`,
    "info",
  );
}

const COMPLETIONS: AutocompleteItem[] = [
  { value: "create ", label: "create", description: "generate and launch a procedure" },
  { value: "run ", label: "run", description: "run a saved procedure" },
  { value: "save ", label: "save", description: "promote a run to a reusable procedure" },
  { value: "list", label: "list", description: "list saved procedures" },
  { value: "pause ", label: "pause", description: "pause new work in a run" },
  { value: "resume ", label: "resume", description: "resume a paused run" },
  { value: "stop ", label: "stop", description: "stop a run" },
  { value: "restart ", label: "restart", description: "start a stopped run again" },
];

function completions(prefix: string): AutocompleteItem[] | null {
  if (prefix.trim().includes(" ")) return null;
  const value = prefix.trimStart().toLowerCase();
  const matches = COMPLETIONS.filter((item) => item.value.trim().startsWith(value));
  return matches.length > 0 ? matches : null;
}

export function registerProcedureCommands(
  pi: ExtensionAPI,
  getService: () => ProcedureService | undefined,
): void {
  pi.registerCommand("proc", {
    description: "Create, save, run, or control a code-driven procedure",
    getArgumentCompletions: completions,
    handler: async (args, ctx) => {
      const service = getService();
      if (!service) {
        ctx.ui.notify("Procedures are still starting.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/proc currently requires TUI mode.", "error");
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Trust this project before creating or running procedures.", "error");
        return;
      }
      try {
        const parsed = tokens(args.trim());
        const action = parsed[0]?.toLowerCase();
        if (action === "list") {
          const definitions = await service.definitions.list();
          ctx.ui.notify(
            definitions.length > 0
              ? definitions
                  .map(
                    (definition) =>
                      `${definition.name} — ${terminalText(definition.title, 160)} [${definition.allowedTools.join(", ")}]`,
                  )
                  .join("\n")
              : "No saved procedures. Use /proc <goal>.",
            "info",
          );
          return;
        }
        if (action === "save") {
          const id = parsed[1];
          if (!id) throw new Error("save requires a run id.");
          if (parsed.length > 3) throw new Error("save accepts only a run id and optional name.");
          const run = service.registry.get(id);
          if (!run) throw new Error(`No procedure run matches ${id}.`);
          const source = await readRetainedRunSource(service, run.sourcePath);
          const definition = await service.definitions.save(
            {
              name: parsed[2] ?? run.procedureName,
              title: run.title,
              description: run.description,
              source,
              requiredTools: run.allowedTools,
            },
            run.goal,
          );
          ctx.ui.notify(
            `Saved reusable procedure ${definition.name} in ${service.definitions.directory}.`,
            "info",
          );
          return;
        }
        if (action === "pause" || action === "resume") {
          const id = parsed[1];
          if (!id) throw new Error(`${action} requires a run id.`);
          if (parsed.length !== 2) throw new Error(`${action} accepts exactly one run id.`);
          const changed =
            action === "pause" ? service.registry.pause(id) : service.registry.resume(id);
          if (!changed) throw new Error(`Procedure ${id} cannot ${action} from its current state.`);
          ctx.ui.notify(`${action === "pause" ? "Paused" : "Resumed"} procedure ${id}.`, "info");
          return;
        }
        if (action === "stop") {
          const id = parsed[1];
          if (!id) throw new Error("stop requires a run id. Open /monitor to choose one.");
          if (parsed.length !== 2) throw new Error("stop accepts exactly one run id.");
          if (!service.registry.stop(id)) throw new Error(`No active procedure matches ${id}.`);
          ctx.ui.notify(`Stopping procedure ${id}.`, "info");
          return;
        }
        if (action === "restart" || action === "start") {
          const id = parsed[1];
          if (!id) throw new Error(`${action} requires a run id.`);
          if (parsed.length !== 2) throw new Error(`${action} accepts exactly one run id.`);
          await restartRun(ctx, service, id);
          return;
        }
        if (action === "approve" || action === "deny") {
          const id = parsed[1];
          if (!id) throw new Error(`${action} requires a run id.`);
          if (!service.registry.approve(id, action === "approve")) {
            throw new Error(`No waiting approval matches ${id}.`);
          }
          return;
        }
        if (action === "run") {
          const name = parsed[1];
          if (!name) throw new Error("run requires a saved procedure name.");
          const definition = await service.definitions.load(name);
          const goal = parsed.slice(2).join(" ").trim() || definition.goal;
          const saved = await service.definitions.source(definition);
          await launch(ctx, service, definition, saved.source, goal);
          return;
        }
        const goal = action === "create" ? parsed.slice(1).join(" ") : args;
        await createAndLaunch(ctx, service, goal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${message}\n${USAGE}`, "error");
      }
    },
  });

  pi.registerCommand("monitor", {
    description: "Open the live Procedures workflow monitor",
    handler: async (args, ctx) => {
      const service = getService();
      if (!service) {
        ctx.ui.notify("Procedures are still starting.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/monitor requires TUI mode.", "error");
        return;
      }
      await showMonitor(ctx, service.registry, args.trim() || undefined, {
        restart: async (runId) => {
          try {
            await restartRun(ctx, service, runId);
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      });
    },
  });

  pi.registerTool({
    name: "procedure_status",
    label: "Procedure Status",
    description:
      "List background procedure runs or inspect one run's metadata, task statuses, current activity, token usage, and errors. Output is capped at 50 KiB and excludes full prompts/results.",
    promptSnippet: "Inspect live or historical background procedure status",
    promptGuidelines: [
      "Use procedure_status when the user asks what a background procedure is doing or whether it completed.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "get"] as const),
      runId: Type.Optional(Type.String({ description: "Full or unique run-id prefix for get" })),
    }),
    async execute(_toolCallId, params) {
      const service = getService();
      if (!service) throw new Error("Procedures are still starting.");
      let value: unknown;
      if (params.action === "list") {
        value = service.registry.list().map((run) => ({
          ...runSummary(run),
          activeTasks: run.tasks
            .filter((task) => task.status === "running" || task.status === "retrying")
            .map((task) => ({ id: task.id, activity: task.activity })),
          usage: run.usage,
        }));
      } else {
        if (!params.runId) throw new Error("runId is required for get.");
        const run = service.registry.get(params.runId);
        if (!run) throw new Error(`No procedure matches ${params.runId}.`);
        value = {
          ...runSummary(run),
          goal: run.goal,
          pendingApproval: run.pendingApproval,
          tasks: run.tasks.map((task) => ({
            id: task.id,
            status: task.status,
            attempt: task.attempt,
            tools: task.tools,
            model: task.model,
            thinkingLevel: task.thinkingLevel,
            activity: task.activity,
            recentTools: task.recentTools.slice(-5).map(({ tool, summary, status }) => ({
              tool,
              summary: summary.replace(/^\[[^\]]+\]\s*/, ""),
              status,
            })),
            usage: task.usage,
            error: task.error,
          })),
          usage: run.usage,
          error: run.error,
        };
      }
      const output = truncateHead(JSON.stringify(value, null, 2), {
        maxBytes: 50 * 1024,
        maxLines: 2_000,
      });
      return {
        content: [
          {
            type: "text",
            text: output.truncated
              ? `${output.content}\n[procedure status truncated; use /monitor for full local detail]`
              : output.content,
          },
        ],
        details: {},
      };
    },
  });
}

export { RUN_ENTRY_TYPE, runSummary };
