import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  lineRangeOverlaps,
  normalizeRepositoryPath,
  pathIsInScope,
  type ChangedLineMap,
} from "./git.ts";
import {
  lstatIfExists,
  nearbyGitMetadataRealPaths,
  repositoryPathHasGitMetadataComponent,
  resolvedPathHasGitMetadataComponent,
  resolvedPathIsWithin,
  type GitMetadataPathCache,
} from "./path-safety.ts";
import type {
  FixOutcome,
  FixSubmission,
  NormalizedReviewSubmission,
  ReviewFinding,
  ReviewSubmission,
  ReviewTargetSnapshot,
} from "./models.ts";

const MAX_FINDINGS = 50;
const MAX_CALLOUTS = 30;
const MAX_TITLE = 240;
const MAX_PATH = 1_024;
const MAX_EXPLANATION = 4_000;
const MAX_SUMMARY = 8_000;
const MAX_LOCATION_CONTEXT_BYTES = 64 * 1_024;
const MIN_FIXER_INPUT_BYTES = 4 * 1_024;
const MIN_FIXER_FINDINGS_BYTES = 1 * 1_024;

/** Conservative byte budgets leave room for tool schemas, system text, output, and prior state. */
export function fixerInputByteBudget(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error("Fixer context window must be a positive number.");
  }
  return Math.max(MIN_FIXER_INPUT_BYTES, Math.floor(contextWindow * 2));
}

export function fixerFindingsByteBudget(contextWindow: number): number {
  return Math.max(MIN_FIXER_FINDINGS_BYTES, Math.floor(fixerInputByteBudget(contextWindow) * 0.4));
}

export const reviewSubmissionSchema = Type.Object(
  {
    verdict: StringEnum(["clean", "findings", "blocked"] as const),
    findings: Type.Array(
      Type.Object({
        priority: StringEnum(["P0", "P1", "P2", "P3"] as const),
        title: Type.String({ minLength: 1, maxLength: MAX_TITLE }),
        path: Type.String({ minLength: 1, maxLength: MAX_PATH }),
        startLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
        endLine: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
        impact: Type.String({ minLength: 1, maxLength: MAX_EXPLANATION }),
        evidence: Type.String({ minLength: 1, maxLength: MAX_EXPLANATION }),
        suggestedFix: Type.String({ minLength: 1, maxLength: MAX_EXPLANATION }),
      }),
      { maxItems: MAX_FINDINGS },
    ),
    humanCallouts: Type.Array(Type.String({ minLength: 1, maxLength: MAX_EXPLANATION }), {
      maxItems: MAX_CALLOUTS,
    }),
    blockedReason: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EXPLANATION })),
  },
  { additionalProperties: false },
);
export type ReviewSubmissionInput = Static<typeof reviewSubmissionSchema>;

export const fixSubmissionSchema = Type.Object(
  {
    status: StringEnum(["fixed", "partial", "blocked"] as const),
    outcomes: Type.Array(
      Type.Object({
        findingId: Type.String({ minLength: 1, maxLength: 128 }),
        status: StringEnum(["fixed", "invalid", "deferred"] as const),
        explanation: Type.String({ minLength: 1, maxLength: MAX_EXPLANATION }),
      }),
      { maxItems: MAX_FINDINGS },
    ),
    checksRun: Type.Array(
      Type.Object({
        command: Type.String({ minLength: 1, maxLength: 2_000 }),
        exitCode: Type.Integer({ minimum: -1, maximum: 255 }),
      }),
      { maxItems: 30 },
    ),
    summary: Type.String({ minLength: 1, maxLength: MAX_SUMMARY }),
  },
  { additionalProperties: false },
);
export type FixSubmissionInput = Static<typeof fixSubmissionSchema>;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string.`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} characters.`);
  return value.trim();
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function requireArray(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  if (value.length > maximum) throw new Error(`${field} exceeds ${maximum} items.`);
  return value;
}

function normalizeWords(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function nearestExistingRealPath(path: string): Promise<string | undefined> {
  let candidate = path;
  for (;;) {
    try {
      return await realpath(candidate);
    } catch (error) {
      const isLoop = error instanceof Error && "code" in error && error.code === "ELOOP";
      if (isLoop) return undefined;
      if (!isMissingPath(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

async function readLocationPrefix(
  absolute: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const stream = createReadStream(absolute, {
    // Node accepts numeric open flags here, although @types/node narrows this field to string.
    flags: (constants.O_RDONLY | constants.O_NONBLOCK) as unknown as string,
    highWaterMark: 16 * 1_024,
    signal,
  });
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_LOCATION_CONTEXT_BYTES - totalBytes;
      chunks.push(buffer.subarray(0, remaining));
      totalBytes += Math.min(buffer.length, remaining);
      if (totalBytes === MAX_LOCATION_CONTEXT_BYTES) break;
    }
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function locationContext(
  repositoryRoot: string,
  finding: ReviewFinding,
  signal?: AbortSignal,
): Promise<string> {
  const absolute = resolve(repositoryRoot, finding.path);
  const itemStat = await lstatIfExists(absolute);
  if (!itemStat) return `${finding.startLine}:${finding.endLine}`;
  if (itemStat.isSymbolicLink()) {
    return `symlink:${await readlink(absolute)}:${finding.startLine}:${finding.endLine}`;
  }
  if (!itemStat.isFile()) {
    return `git-entry:${itemStat.mode}:${finding.startLine}:${finding.endLine}`;
  }
  const content = await readLocationPrefix(absolute, signal);
  if (!content) return `${finding.startLine}:${finding.endLine}`;
  const lines = content.split("\n");
  const start = Math.max(0, finding.startLine - 3);
  const end = Math.min(lines.length, finding.endLine + 2);
  if (start >= lines.length) return `${finding.startLine}:${finding.endLine}`;
  return lines
    .slice(start, end)
    .map((line) => line.trim())
    .join("\n");
}

async function assertSafeFindingPath(
  target: ReviewTargetSnapshot,
  input: string,
  allowChangedNonRegularEntry: boolean,
  signal?: AbortSignal,
  metadataCache?: GitMetadataPathCache,
): Promise<string> {
  if (isAbsolute(input)) throw new Error(`Finding path must be repository-relative: ${input}`);
  const normalized = normalizeRepositoryPath(target.repositoryRoot, input);
  if (normalized === ".")
    throw new Error("A finding path must identify a file, not the repository root.");
  if (target.type === "folder" && !pathIsInScope(normalized, target.paths ?? [])) {
    throw new Error(`Finding path is outside the selected folder scope: ${normalized}`);
  }
  if (target.type === "folder" && repositoryPathHasGitMetadataComponent(normalized)) {
    throw new Error(`Finding path may not identify Git metadata: ${normalized}`);
  }

  const absolute = resolve(target.repositoryRoot, normalized);
  const itemStat = await lstatIfExists(absolute);
  if (target.type === "folder" && !itemStat) {
    throw new Error(`Finding path does not exist in the selected folder scope: ${normalized}`);
  }
  if (itemStat) {
    // Diff evidence is tied to the lexical Git entry. Do not follow changed symlinks (which may
    // be broken or point outside the repository), and allow changed gitlinks/submodule entries.
    if (allowChangedNonRegularEntry && !itemStat.isFile()) return normalized;

    if (target.type === "folder" && itemStat.isSymbolicLink()) {
      const [rootReal, parentReal] = await Promise.all([
        realpath(target.repositoryRoot),
        realpath(dirname(absolute)),
      ]);
      if (!resolvedPathIsWithin(rootReal, parentReal)) {
        throw new Error(`Finding path resolves outside the repository: ${normalized}`);
      }
      const metadataPaths = await nearbyGitMetadataRealPaths(
        target.repositoryRoot,
        parentReal,
        signal,
        metadataCache,
      );
      if (
        resolvedPathHasGitMetadataComponent(rootReal, parentReal) ||
        metadataPaths.some((metadataPath) => resolvedPathIsWithin(metadataPath, parentReal))
      ) {
        throw new Error(`Finding path may not identify Git metadata: ${normalized}`);
      }
      const scopeReals = await Promise.all(
        (target.paths ?? []).map((scope) => realpath(resolve(target.repositoryRoot, scope))),
      );
      if (!scopeReals.some((scopeReal) => resolvedPathIsWithin(scopeReal, parentReal))) {
        throw new Error(`Finding path resolves outside the selected folder scope: ${normalized}`);
      }
      const lexicalDestination = resolve(parentReal, await readlink(absolute));
      if (
        resolvedPathHasGitMetadataComponent(rootReal, lexicalDestination) ||
        metadataPaths.some((metadataPath) => resolvedPathIsWithin(metadataPath, lexicalDestination))
      ) {
        throw new Error(`Finding path may not identify Git metadata: ${normalized}`);
      }
      const destinationReal = await nearestExistingRealPath(lexicalDestination);
      if (destinationReal) {
        const resolvesToMetadata =
          resolvedPathHasGitMetadataComponent(rootReal, destinationReal) ||
          metadataPaths.some((metadataPath) => resolvedPathIsWithin(metadataPath, destinationReal));
        if (resolvesToMetadata) {
          throw new Error(`Finding path may not identify Git metadata: ${normalized}`);
        }
      }
      return normalized;
    }

    const [rootReal, itemReal] = await Promise.all([
      realpath(target.repositoryRoot),
      realpath(absolute),
    ]);
    if (!resolvedPathIsWithin(rootReal, itemReal)) {
      throw new Error(`Finding path resolves outside the repository: ${normalized}`);
    }
    if (target.type === "folder") {
      const metadataPaths = await nearbyGitMetadataRealPaths(
        target.repositoryRoot,
        itemReal,
        signal,
        metadataCache,
      );
      if (
        resolvedPathHasGitMetadataComponent(rootReal, itemReal) ||
        metadataPaths.some((metadataPath) => resolvedPathIsWithin(metadataPath, itemReal))
      ) {
        throw new Error(`Finding path may not identify Git metadata: ${normalized}`);
      }
    }
    if (!(await stat(itemReal)).isFile()) {
      throw new Error(`Finding path must identify a regular file: ${normalized}`);
    }
    if (target.type === "folder") {
      const scopeReals = await Promise.all(
        (target.paths ?? []).map((scope) => realpath(resolve(target.repositoryRoot, scope))),
      );
      if (!scopeReals.some((scopeReal) => resolvedPathIsWithin(scopeReal, itemReal))) {
        throw new Error(`Finding path resolves outside the selected folder scope: ${normalized}`);
      }
    }
  }
  return normalized;
}

export interface ValidateReviewOptions {
  target: ReviewTargetSnapshot;
  pass: number;
  changedLines?: ChangedLineMap;
  maxFindingsBytes?: number;
  signal?: AbortSignal;
}

export async function validateReviewSubmission(
  value: unknown,
  options: ValidateReviewOptions,
): Promise<NormalizedReviewSubmission> {
  const input = requireRecord(value, "Review submission");
  const verdict = input.verdict;
  if (verdict !== "clean" && verdict !== "findings" && verdict !== "blocked") {
    throw new Error("Review verdict must be clean, findings, or blocked.");
  }

  const rawFindings = requireArray(input.findings, "findings", MAX_FINDINGS);
  const callouts = requireArray(input.humanCallouts, "humanCallouts", MAX_CALLOUTS).map(
    (callout, index) => requireString(callout, `humanCallouts[${index}]`, MAX_EXPLANATION),
  );
  const blockedReason =
    input.blockedReason === undefined
      ? undefined
      : requireString(input.blockedReason, "blockedReason", MAX_EXPLANATION);

  if (verdict === "clean" && (rawFindings.length > 0 || blockedReason)) {
    throw new Error("A clean review must have no findings and no blocked reason.");
  }
  if (verdict === "findings" && rawFindings.length === 0) {
    throw new Error("A findings verdict requires at least one finding.");
  }
  if (verdict === "blocked" && !blockedReason) {
    throw new Error("A blocked review requires blockedReason.");
  }

  const findings: ReviewFinding[] = [];
  const fingerprints = new Set<string>();
  const metadataCache: GitMetadataPathCache = new Map();
  for (let index = 0; index < rawFindings.length; index += 1) {
    const raw = requireRecord(rawFindings[index], `findings[${index}]`);
    const priority = raw.priority;
    if (priority !== "P0" && priority !== "P1" && priority !== "P2" && priority !== "P3") {
      throw new Error(`findings[${index}].priority is invalid.`);
    }
    const startLine = requireInteger(raw.startLine, `findings[${index}].startLine`);
    const endLine = requireInteger(raw.endLine, `findings[${index}].endLine`);
    if (endLine < startLine) throw new Error(`findings[${index}] has an inverted line range.`);
    if (endLine - startLine > 200) throw new Error(`findings[${index}] line range is too broad.`);
    const inputPath = requireString(raw.path, `findings[${index}].path`, MAX_PATH);
    if (isAbsolute(inputPath)) {
      throw new Error(`Finding path must be repository-relative: ${inputPath}`);
    }
    const normalizedPath = normalizeRepositoryPath(options.target.repositoryRoot, inputPath);
    const overlapsChangedLocation =
      options.target.type !== "folder" &&
      options.changedLines !== undefined &&
      lineRangeOverlaps(options.changedLines, normalizedPath, startLine, endLine);
    const path = await assertSafeFindingPath(
      options.target,
      normalizedPath,
      overlapsChangedLocation,
      options.signal,
      metadataCache,
    );
    if (options.target.type !== "folder" && !overlapsChangedLocation) {
      throw new Error(`Finding ${index + 1} does not overlap a changed line in ${path}.`);
    }

    const finding: ReviewFinding = {
      id: "pending",
      fingerprint: "pending",
      pass: options.pass,
      priority,
      title: requireString(raw.title, `findings[${index}].title`, MAX_TITLE),
      path,
      startLine,
      endLine,
      impact: requireString(raw.impact, `findings[${index}].impact`, MAX_EXPLANATION),
      evidence: requireString(raw.evidence, `findings[${index}].evidence`, MAX_EXPLANATION),
      suggestedFix: requireString(
        raw.suggestedFix,
        `findings[${index}].suggestedFix`,
        MAX_EXPLANATION,
      ),
    };
    const context = await locationContext(options.target.repositoryRoot, finding, options.signal);
    const fingerprint = createHash("sha256")
      .update(
        [
          path,
          String(startLine),
          String(endLine),
          priority,
          normalizeWords(finding.title),
          normalizeWords(context),
        ].join("\0"),
      )
      .digest("hex");
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    finding.fingerprint = fingerprint;
    finding.id = `RL-${fingerprint.slice(0, 12)}`;
    findings.push(finding);
  }

  if (verdict === "findings" && findings.length === 0) {
    throw new Error("All submitted findings were duplicates; no distinct finding remains.");
  }
  if (options.maxFindingsBytes !== undefined) {
    const serializedBytes = Buffer.byteLength(JSON.stringify(findings), "utf8");
    if (serializedBytes > options.maxFindingsBytes) {
      throw new Error(
        `findings exceed the aggregate fixer-input budget (${serializedBytes} > ${options.maxFindingsBytes} bytes); resubmit concise findings while preserving each distinct issue.`,
      );
    }
  }

  const result: NormalizedReviewSubmission = { verdict, findings, humanCallouts: callouts };
  if (blockedReason) result.blockedReason = blockedReason;
  return result;
}

export function validateFixSubmission(
  value: unknown,
  expectedFindingIds: readonly string[],
): FixSubmission {
  const input = requireRecord(value, "Fix submission");
  if (input.status !== "fixed" && input.status !== "partial" && input.status !== "blocked") {
    throw new Error("Fix status must be fixed, partial, or blocked.");
  }
  const expected = new Set(expectedFindingIds);
  const seen = new Set<string>();
  const outcomes = requireArray(input.outcomes, "outcomes", MAX_FINDINGS).map((entry, index) => {
    const outcome = requireRecord(entry, `outcomes[${index}]`);
    const findingId = requireString(outcome.findingId, `outcomes[${index}].findingId`, 128);
    if (!expected.has(findingId))
      throw new Error(`Unknown finding ID in fixer outcome: ${findingId}`);
    if (seen.has(findingId)) throw new Error(`Duplicate fixer outcome for ${findingId}.`);
    seen.add(findingId);
    const status = outcome.status;
    if (status !== "fixed" && status !== "invalid" && status !== "deferred") {
      throw new Error(`outcomes[${index}].status is invalid.`);
    }
    return {
      findingId,
      status,
      explanation: requireString(
        outcome.explanation,
        `outcomes[${index}].explanation`,
        MAX_EXPLANATION,
      ),
    } satisfies FixOutcome;
  });
  for (const id of expected) {
    if (!seen.has(id)) throw new Error(`Fixer omitted an outcome for ${id}.`);
  }

  const checksRun = requireArray(input.checksRun, "checksRun", 30).map((entry, index) => {
    const check = requireRecord(entry, `checksRun[${index}]`);
    const exitCode = check.exitCode;
    if (
      typeof exitCode !== "number" ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < -1 ||
      exitCode > 255
    ) {
      throw new Error(`checksRun[${index}].exitCode is invalid.`);
    }
    return {
      command: requireString(check.command, `checksRun[${index}].command`, 2_000),
      exitCode,
    };
  });
  return {
    status: input.status,
    outcomes,
    checksRun,
    summary: requireString(input.summary, "summary", MAX_SUMMARY),
  };
}

export function asReviewSubmission(input: ReviewSubmissionInput): ReviewSubmission {
  return input as ReviewSubmission;
}

export function asFixSubmission(input: FixSubmissionInput): FixSubmission {
  return input as FixSubmission;
}
