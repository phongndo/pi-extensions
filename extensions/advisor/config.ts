import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clampThinkingLevel,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePreferenceJson } from "../../src/preference-file.ts";
import { isRequestSpeedPreference, type RequestSpeedPreference } from "../../src/request-speed.ts";

export const ADVISOR_CONFIG_PATH = join(getAgentDir(), "advisor.json");

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

/** The advisor exists to think harder than the executor, so it defaults high. */
export const DEFAULT_THINKING: ModelThinkingLevel = "high";

/** The global advisor preference: which model answers `advisor` calls, and how hard it thinks. */
export interface AdvisorChoice {
  provider: string;
  model: string;
  /** Clamped to what the model supports at call time; omitted means {@link DEFAULT_THINKING}. */
  thinking?: ModelThinkingLevel;
  /** Omitted means Inherit, including in existing version-1 configs. */
  speed?: RequestSpeedPreference;
}

interface AdvisorConfigFile {
  version: 1;
  advisor: AdvisorChoice | null;
}

export function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function modelRef(model: Pick<Model<Api>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

export function formatChoice(choice: AdvisorChoice): string {
  return `${choice.provider}/${choice.model}${choice.thinking ? `:${choice.thinking}` : ""}`;
}

/** Split `provider/model[:thinking]`. Model ids may contain `:`, so only a known level is a suffix. */
export function parseSpec(spec: string): { ref: string; thinking?: ModelThinkingLevel } {
  const trimmed = spec.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0) {
    const suffix = trimmed.slice(colon + 1).toLowerCase();
    if (isThinkingLevel(suffix)) return { ref: trimmed.slice(0, colon), thinking: suffix };
  }
  return { ref: trimmed };
}

/** The level a call uses: the stored preference clamped to the model, like Pi's own model switch. */
export function effectiveThinking(
  model: Model<Api>,
  thinking: ModelThinkingLevel | undefined,
): ModelThinkingLevel {
  return clampThinkingLevel(model, thinking ?? DEFAULT_THINKING);
}

/**
 * Resolve `provider/model` exactly, or a bare model id when exactly one candidate has it.
 * `find` covers every known model; `candidates` (models with credentials) disambiguate bare ids.
 */
export function resolveModelRef(
  ref: string,
  find: (provider: string, id: string) => Model<Api> | undefined,
  candidates: readonly Model<Api>[],
): Model<Api> | string {
  if (!ref) return "Name a model as provider/model.";
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const exact = find(ref.slice(0, slash), ref.slice(slash + 1));
    if (exact) return exact;
    const listed = candidates.find((model) => modelRef(model) === ref);
    if (listed) return listed;
  }
  const matches = candidates.filter((model) => model.id === ref);
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    return `Model id ${ref} is ambiguous: ${matches.map(modelRef).join(", ")}. Use provider/model.`;
  }
  return `Unknown model: ${ref}.`;
}

function parseConfig(value: unknown): AdvisorChoice | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Advisor config must be a JSON object.");
  }
  const config = value as Record<string, unknown>;
  if (config.version !== 1) {
    throw new Error(`Unsupported advisor config version: ${String(config.version)}.`);
  }
  if (config.advisor === null || config.advisor === undefined) return undefined;
  const advisor = config.advisor as Record<string, unknown>;
  if (
    typeof advisor !== "object" ||
    typeof advisor.provider !== "string" ||
    !advisor.provider ||
    typeof advisor.model !== "string" ||
    !advisor.model ||
    (advisor.thinking !== undefined && !isThinkingLevel(advisor.thinking))
  ) {
    throw new Error("Advisor config needs a provider, a model, and an optional thinking level.");
  }
  if (advisor.speed !== undefined && !isRequestSpeedPreference(advisor.speed)) {
    throw new Error("Advisor speed must be inherit, standard, fast, or ultrafast.");
  }
  return {
    provider: advisor.provider,
    model: advisor.model,
    ...(advisor.thinking ? { thinking: advisor.thinking as ModelThinkingLevel } : {}),
    ...(advisor.speed !== undefined ? { speed: advisor.speed } : {}),
  };
}

export async function loadAdvisorChoice(
  path: string = ADVISOR_CONFIG_PATH,
): Promise<AdvisorChoice | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read advisor config at ${path}.`, { cause: error });
  }
  try {
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Invalid advisor config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function saveAdvisorChoice(
  choice: AdvisorChoice | undefined,
  path: string = ADVISOR_CONFIG_PATH,
): Promise<void> {
  const config: AdvisorConfigFile = { version: 1, advisor: choice ?? null };
  // A whole-file atomic replace with no read-modify-write, so no lock is needed. (proper-lockfile
  // also crashes Pi on a second lock in one process: Pi's guarded fs rejects its cached probe.)
  try {
    await writePreferenceJson(path, config);
  } catch (error) {
    throw new Error(`Could not save advisor config at ${path}.`, { cause: error });
  }
}
