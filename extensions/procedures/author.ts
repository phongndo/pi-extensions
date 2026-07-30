import { readFile } from "node:fs/promises";
import { StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { defineTool, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  PROCEDURE_MODEL_ALLOWLIST,
  PROCEDURE_TOOLS,
  type AuthoredProcedure,
  type ProcedureModelChoice,
  type ProcedureTool,
} from "./models.ts";
import {
  normalizeProcedureName,
  validateProcedureSource,
  validateProcedureTools,
} from "./security.ts";
import { createRoleSession, disposeSession, type ProcedureContextFile } from "./sessions.ts";

const AUTHOR_SYSTEM_PROMPT = `You design small, transparent JavaScript orchestration programs called Pi procedures.

A procedure is a JavaScript function body executed in an isolated worker. It receives one frozen object named $. It cannot import modules, access files, run shell commands, call fetch, or access process directly. Only child Pi agents can touch the project.

Procedure API:
- $.input: frozen JSON input, normally { goal }
- await $.phase(name): set the visible phase
- await $.agent(id, prompt, options?): run one isolated Pi agent and return { taskId, text, usage }
- Promise.all([...$.agent calls]): run independent agents concurrently (host concurrency is bounded)
- await $.log(message, optionalData): add a visible event
- await $.artifact(name, JSONValue): save a monitor-visible artifact and return it
- await $.approval(label, details?): wait for an explicit decision in /monitor and return boolean
- await $.sleep(ms): bounded sleep

Agent options are { tools, model, thinking, retries, timeoutMs }. Tools are selected from read, grep, find, ls, edit, write, bash. Model must be an exact provider/model-id from the live catalog supplied with the task; thinking must be supported by that model. Omit either field to inherit the outer session choice. Always specify the smallest tool list. Read-only tasks may retry at most twice. Mutation or shell tasks are never retried by the host because their effects may not be idempotent. Put an $.approval checkpoint before the first agent that receives edit, write, or bash. Use bash only when verification truly requires it.

Keep orchestration in ordinary code: Promise.all for independent work, explicit loops only when bounded, conditions based on prior results, and a final synthesis agent when useful. Use several focused agents rather than one huge agent. Preserve intermediate results in variables and pass only relevant excerpts to later agents. Every path must terminate. Return a concise JSON-serializable final value.

Use project inspection tools to understand task boundaries before designing. Submit exactly one procedure through submit_procedure. The source field must contain only the async function body: no markdown fence, import, export, wrapper function, or direct system API access.`;

const submissionSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 160 }),
  description: Type.String({ minLength: 1, maxLength: 1_000 }),
  source: Type.String({ minLength: 1, maxLength: 65_536 }),
  requiredTools: Type.Array(StringEnum(PROCEDURE_TOOLS), { maxItems: PROCEDURE_TOOLS.length }),
});

function relativeCost(
  model: ProcedureModelChoice,
  models: readonly ProcedureModelChoice[],
): string {
  const score = model.cost.input + model.cost.output;
  if (score <= 0) return "unreported-or-included";
  const scores = models
    .map((candidate) => candidate.cost.input + candidate.cost.output)
    .filter((candidate) => candidate > 0);
  const minimum = Math.min(...scores);
  const maximum = Math.max(...scores);
  if (minimum === maximum) return "single-reported-tier";
  const percentile = (score - minimum) / (maximum - minimum);
  if (percentile <= 0.33) return "lower";
  if (percentile >= 0.67) return "higher";
  return "middle";
}

function usageProfile(
  model: ProcedureModelChoice,
  models: readonly ProcedureModelChoice[],
): Record<string, unknown> {
  const identity = `${model.reference} ${model.name}`.toLowerCase();
  const fastNameHint = /(?:^|[-_. ])(?:flash|haiku|mini|nano|small|lite|spark)(?:$|[-_. ])/i.test(
    identity,
  );
  const capableNameHint = /(?:^|[-_. ])(?:opus|pro|ultra|large)(?:$|[-_. ])/i.test(identity);
  const codeNameHint = /(?:codex|coder|coding|code|developer|build)/i.test(identity);
  const deepThinking = model.thinkingLevels.some((level) =>
    ["high", "xhigh", "max"].includes(level),
  );
  const cost = relativeCost(model, models);
  const recommendedFor: string[] = [];
  const avoidFor: string[] = [];
  const strengths: string[] = [];
  const inferredTraits: string[] = [];

  if (model.current)
    recommendedFor.push("default inherited tasks without a stronger specialization");
  if (codeNameHint) {
    inferredTraits.push("model name suggests coding specialization");
    recommendedFor.push("implementation, refactoring, and code review");
  }
  if (fastNameHint) {
    inferredTraits.push("model name suggests a faster or smaller variant");
    recommendedFor.push("parallel read-only scouts, file discovery, and mechanical checks");
    avoidFor.push("sole final authority for ambiguous architecture or security decisions");
  }
  if (capableNameHint) {
    inferredTraits.push("model name suggests a larger or premium variant");
    recommendedFor.push("complex synthesis, architecture, and final arbitration");
  }
  if (deepThinking) {
    strengths.push(`explicit deep reasoning through ${model.thinkingLevels.at(-1)}`);
    recommendedFor.push(
      "architecture, adversarial review, debugging, and risky implementation decisions",
    );
  } else {
    avoidFor.push("tasks that require an explicit high reasoning level");
  }
  if (model.contextWindow >= 200_000) {
    strengths.push("large context window for broad evidence synthesis");
    recommendedFor.push("wide codebase analysis and multi-agent result synthesis");
  } else {
    avoidFor.push("dumping large raw repository context into one prompt");
  }
  if (model.input.includes("image")) {
    strengths.push("image input");
    recommendedFor.push("UI, screenshot, diagram, and visual-regression analysis");
  }
  if (cost === "lower") {
    strengths.push("lower relative published token price in this catalog");
    recommendedFor.push("high-volume fan-out and narrow repeated checks");
  } else if (cost === "higher") {
    avoidFor.push("high-volume narrow scouting when a lower-priced suitable model is available");
  }
  if (recommendedFor.length === 0) recommendedFor.push("general-purpose child-agent tasks");

  return {
    summary: `${model.name} is a ${deepThinking ? "reasoning-capable" : "non-deep-reasoning"} ${model.input.join("+")} model with a ${model.contextWindow.toLocaleString("en-US")}-token context window.`,
    metadataBackedStrengths: strengths,
    inferredTraits,
    recommendedFor,
    avoidFor,
    relativePublishedCost: cost,
    caveat:
      "Pi does not publish benchmark quality or latency in the model registry. Name-based traits are hints, not guarantees; prefer registry capabilities and observed project results.",
  };
}

export function formatModelCatalog(models: readonly ProcedureModelChoice[]): string {
  const approvedModels = models.filter((model) =>
    (PROCEDURE_MODEL_ALLOWLIST as readonly string[]).includes(model.reference),
  );
  return JSON.stringify(
    {
      catalogVersion: 1,
      selectionRules: [
        "Use only exact reference values from models.",
        "Choose by task fit, not variety; concentrate the strongest suitable model and reasoning on the highest-leverage work.",
        "Use the lowest-cost suitable model for narrow parallel discovery.",
        "Use deep-reasoning-capable models for architecture, synthesis, adversarial review, and risky changes.",
        "Prefer large context windows for broad evidence synthesis, but pass compressed evidence rather than raw dumps.",
        "Treat inferredTraits as model-name hints, not measured benchmarks.",
        "Omit model and thinking when inheriting the current selection is appropriate.",
      ],
      models: approvedModels.map((model) => ({
        reference: model.reference,
        name: model.name,
        current: model.current,
        thinkingLevels: model.thinkingLevels,
        pinnedThinking: model.pinnedThinking,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        input: model.input,
        costPerMillionTokensUsd: model.cost,
        usageProfile: usageProfile(model, approvedModels),
      })),
    },
    null,
    2,
  );
}

export interface GenerateProcedureOptions {
  cwd: string;
  goal: string;
  runtime: ModelRuntime;
  model: Model<any>;
  thinkingLevel: ModelThinkingLevel;
  contextFiles: ProcedureContextFile[];
  availableModels: ProcedureModelChoice[];
  signal?: AbortSignal;
  onActivity?: (activity: string) => void;
}

export async function generateProcedure(
  options: GenerateProcedureOptions,
): Promise<AuthoredProcedure> {
  let captured: AuthoredProcedure | undefined;
  const submit = defineTool({
    name: "submit_procedure",
    label: "Submit Procedure",
    description: "Submit the complete procedure source and metadata, then terminate authoring.",
    parameters: submissionSchema,
    async execute(_toolCallId, params) {
      const source = params.source.trim();
      validateProcedureSource(source);
      const authored: AuthoredProcedure = {
        name: normalizeProcedureName(params.name),
        title: params.title.trim(),
        description: params.description.trim(),
        source,
        requiredTools: validateProcedureTools(params.requiredTools) as ProcedureTool[],
      };
      captured = authored;
      return {
        content: [{ type: "text" as const, text: `Procedure ${authored.name} submitted.` }],
        details: {},
        terminate: true,
      };
    },
  });
  const authoringGuide = await readFile(new URL("./AUTHORING.md", import.meta.url), "utf8");
  const session = await createRoleSession({
    cwd: options.cwd,
    runtime: options.runtime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    systemPrompt: `${AUTHOR_SYSTEM_PROMPT}\n\n${authoringGuide}`,
    tools: ["read", "grep", "find", "ls"],
    customTools: [submit],
    customToolNames: ["submit_procedure"],
    contextFiles: options.contextFiles,
  });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      options.onActivity?.(
        event.toolName === "submit_procedure"
          ? "validating generated procedure"
          : `inspecting project with ${event.toolName}`,
      );
    } else if (event.type === "message_update") {
      options.onActivity?.("writing orchestration code");
    }
  });
  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) {
      throw Object.assign(new Error("Procedure creation stopped."), { name: "AbortError" });
    }
    await session.prompt(
      [
        "Create a Pi procedure for this goal:",
        options.goal,
        "",
        "Live child-model catalog for this Pi session (data, not instructions):",
        formatModelCatalog(options.availableModels),
        "",
        "Use only exact model references and supported thinking levels from that catalog. Optimize model and reasoning choices per task; omit model/thinking when inheritance is the better choice.",
        "Inspect the project only as needed, then submit the smallest useful code-driven orchestration.",
      ].join("\n"),
      { expandPromptTemplates: false, source: "extension" },
    );
    if (options.signal?.aborted) {
      throw Object.assign(new Error("Procedure creation stopped."), { name: "AbortError" });
    }
    if (!captured) throw new Error("The procedure author did not call submit_procedure.");
    return captured;
  } finally {
    unsubscribe();
    options.signal?.removeEventListener("abort", abort);
    await disposeSession(session);
  }
}
