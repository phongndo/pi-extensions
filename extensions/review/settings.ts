import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { REVIEW_MODES, type ModelReference, type ReviewLoopSettings } from "./models.ts";
import { reviewerCountForMode } from "./review-modes.ts";

export const REVIEW_LOOP_SETTINGS_PATH = join(getAgentDir(), "review-loop.json");
export const REVIEW_LOOP_SETTINGS_VERSION = 2;
export const MAX_REVIEWER_COUNT = 8;
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ModelThinkingLevel[];

const MAXIMUM_PASS_LIMIT = 20;
const SETTINGS_KEYS = new Set([
  "version",
  "reviewMode",
  "reviewerCount",
  "reviewerModel",
  "reviewerThinking",
  "fixerModel",
  "fixerThinking",
  "maximumPasses",
  "requiredCleanRuns",
  "fixP3Findings",
  "fixerContext",
  "verificationCommand",
  "reviewInstructions",
  // Supported keys from the pre-versioned design-draft shape.
  "maxPasses",
  "fixP3",
]);
const MODEL_REFERENCE_KEYS = new Set(["provider", "modelId", "id"]);

export function defaultSettings(): ReviewLoopSettings {
  return {
    version: REVIEW_LOOP_SETTINGS_VERSION,
    reviewMode: "standard",
    reviewerCount: reviewerCountForMode("standard"),
    maximumPasses: 4,
    requiredCleanRuns: 1,
    fixP3Findings: true,
    fixerContext: "continuous",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maximum = 32_000,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new Error(`${field} exceeds ${maximum} characters.`);
  return trimmed || undefined;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  if (value < minimum || value > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function parseModelReference(value: unknown, field: string): ModelReference | undefined {
  if (value === undefined || value === null || value === "current model") return undefined;
  if (typeof value === "string") {
    const separator = value.indexOf("/");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`${field} must use provider/model format.`);
    }
    return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
  }
  if (!isRecord(value)) throw new Error(`${field} must be a model reference.`);
  assertKnownKeys(value, MODEL_REFERENCE_KEYS, field);
  const provider = optionalTrimmedString(value.provider, `${field}.provider`);
  const modelId = optionalTrimmedString(value.modelId ?? value.id, `${field}.modelId`);
  if (!provider || !modelId) throw new Error(`${field} must include provider and modelId.`);
  return { provider, modelId };
}

function parseThinkingLevel(value: unknown, field: string): ModelThinkingLevel | undefined {
  if (value === undefined || value === null || value === "current level") return undefined;
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${field} is not a supported thinking level.`);
  }
  return value as ModelThinkingLevel;
}

function parseReviewMode(value: unknown): ReviewLoopSettings["reviewMode"] {
  if (value === undefined) return "standard";
  // Modes briefly supported before the panel was simplified map to the remaining specialized mode.
  if (value === "security" || value === "migration") return "adversarial";
  if (
    typeof value !== "string" ||
    !REVIEW_MODES.includes(value as ReviewLoopSettings["reviewMode"])
  ) {
    throw new Error(`reviewMode must be one of: ${REVIEW_MODES.join(", ")}.`);
  }
  return value as ReviewLoopSettings["reviewMode"];
}

/** Migrate version 1 and pre-versioned settings into the current panel-aware schema. */
export function normalizeSettings(value: unknown): ReviewLoopSettings {
  if (!isRecord(value)) throw new Error("Review-loop settings must contain a JSON object.");
  assertKnownKeys(value, SETTINGS_KEYS, "Review-loop settings");
  if (
    value.version !== undefined &&
    value.version !== 1 &&
    value.version !== REVIEW_LOOP_SETTINGS_VERSION
  ) {
    throw new Error(`Unsupported review-loop settings version: ${String(value.version)}.`);
  }

  const defaults = defaultSettings();
  const reviewMode = parseReviewMode(value.reviewMode);
  const reviewerCount = boundedInteger(
    value.reviewerCount,
    "reviewerCount",
    1,
    MAX_REVIEWER_COUNT,
    reviewerCountForMode(reviewMode),
  );
  const maximumValue = value.maximumPasses ?? value.maxPasses;
  const maximumPasses =
    maximumValue === "unlimited"
      ? "unlimited"
      : boundedInteger(maximumValue, "maximumPasses", 1, MAXIMUM_PASS_LIMIT, 4);
  const requiredCleanRuns = boundedInteger(
    value.requiredCleanRuns,
    "requiredCleanRuns",
    1,
    maximumPasses === "unlimited" ? MAXIMUM_PASS_LIMIT : maximumPasses,
    defaults.requiredCleanRuns,
  );

  const fixP3 = value.fixP3Findings ?? value.fixP3;
  if (fixP3 !== undefined && typeof fixP3 !== "boolean") {
    throw new Error("fixP3Findings must be a boolean.");
  }

  const fixerContext = value.fixerContext ?? defaults.fixerContext;
  if (fixerContext !== "continuous" && fixerContext !== "fresh") {
    throw new Error('fixerContext must be "continuous" or "fresh".');
  }

  const settings: ReviewLoopSettings = {
    version: REVIEW_LOOP_SETTINGS_VERSION,
    reviewMode,
    reviewerCount,
    maximumPasses,
    requiredCleanRuns,
    fixP3Findings: fixP3 ?? defaults.fixP3Findings,
    fixerContext,
  };

  const reviewerModel = parseModelReference(value.reviewerModel, "reviewerModel");
  const reviewerThinking = parseThinkingLevel(value.reviewerThinking, "reviewerThinking");
  const fixerModel = parseModelReference(value.fixerModel, "fixerModel");
  const fixerThinking = parseThinkingLevel(value.fixerThinking, "fixerThinking");
  const verificationCommand = optionalTrimmedString(
    value.verificationCommand,
    "verificationCommand",
    4_000,
  );
  const reviewInstructions = optionalTrimmedString(value.reviewInstructions, "reviewInstructions");

  if (reviewerModel) settings.reviewerModel = reviewerModel;
  if (reviewerThinking) settings.reviewerThinking = reviewerThinking;
  if (fixerModel) settings.fixerModel = fixerModel;
  if (fixerThinking) settings.fixerThinking = fixerThinking;
  if (verificationCommand) settings.verificationCommand = verificationCommand;
  if (reviewInstructions) settings.reviewInstructions = reviewInstructions;
  return settings;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadSettings(
  path: string = REVIEW_LOOP_SETTINGS_PATH,
): Promise<ReviewLoopSettings> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return defaultSettings();
    throw new Error(`Could not read review-loop settings at ${path}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed JSON in review-loop settings at ${path}.`, { cause: error });
  }

  let normalized: ReviewLoopSettings;
  try {
    normalized = normalizeSettings(parsed);
  } catch (error) {
    throw new Error(
      `Invalid review-loop settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const sourceVersion = isRecord(parsed) ? parsed.version : undefined;
  if (sourceVersion !== REVIEW_LOOP_SETTINGS_VERSION) {
    try {
      await saveSettings(normalized, path);
    } catch (error) {
      throw new Error(`Could not persist migrated review-loop settings at ${path}.`, {
        cause: error,
      });
    }
  }
  return normalized;
}

export async function saveSettings(
  settings: ReviewLoopSettings,
  path: string = REVIEW_LOOP_SETTINGS_PATH,
): Promise<void> {
  const normalized = normalizeSettings(settings);
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not save review-loop settings at ${path}.`, { cause: error });
  }
}

export class ReviewLoopSettingsStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private settings: ReviewLoopSettings;
  private readonly path: string;

  constructor(settings: ReviewLoopSettings, path: string = REVIEW_LOOP_SETTINGS_PATH) {
    this.settings = settings;
    this.path = path;
  }

  get(): ReviewLoopSettings {
    return structuredClone(this.settings);
  }

  update(mutator: (settings: ReviewLoopSettings) => void): Promise<void> {
    const next = structuredClone(this.settings);
    mutator(next);
    this.settings = normalizeSettings(next);
    const snapshot = structuredClone(this.settings);
    const write = this.writeQueue.then(() => saveSettings(snapshot, this.path));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }
}
