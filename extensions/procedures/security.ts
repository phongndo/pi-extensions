import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { PROCEDURE_TOOLS, type ProcedureTool } from "./models.ts";

const MAX_SOURCE_BYTES = 64 * 1024;
const FORBIDDEN_SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\bimport\s*\(/, "dynamic import"],
  [/\bimport\s+[\w*{]/, "static import"],
  [/\brequire\s*\(/, "require"],
  [/\bprocess\s*\./, "process access"],
  [/\bglobalThis\b/, "globalThis access"],
  [/\b(?:eval|Function)\s*\(/, "dynamic code generation"],
  [/\bWebAssembly\b/, "WebAssembly"],
];

export function normalizeProcedureName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!normalized) throw new Error("Procedure name must contain a letter or number.");
  return normalized;
}

export function validateProcedureSource(source: string): void {
  if (!source.trim()) throw new Error("Procedure source is empty.");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`Procedure source exceeds ${MAX_SOURCE_BYTES / 1024} KiB.`);
  }
  for (const [pattern, label] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(source)) throw new Error(`Procedure source may not use ${label}.`);
  }
  try {
    // Parse the generated body without executing it. The isolated worker compiles it again.
    new Function("$", `"use strict"; return (async () => {\n${source}\n});`);
  } catch (error) {
    throw new Error(
      `Procedure source does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateProcedureTools(values: readonly string[]): ProcedureTool[] {
  const known = new Set<string>(PROCEDURE_TOOLS);
  const result: ProcedureTool[] = [];
  for (const value of values) {
    if (!known.has(value)) throw new Error(`Unknown procedure tool: ${value}`);
    if (!result.includes(value as ProcedureTool)) result.push(value as ProcedureTool);
  }
  return result;
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resolveThroughExistingParent(path: string): Promise<string> {
  let candidate = path;
  const suffix: string[] = [];
  while (!(await lstatOrUndefined(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    suffix.unshift(candidate.slice(parent.length + 1));
    candidate = parent;
  }
  return resolve(await realpath(candidate), ...suffix);
}

export async function scopedProjectPath(
  root: string,
  input: string,
  options: { mutation?: boolean } = {},
): Promise<string> {
  const rootReal = await realpath(root);
  const candidate = resolve(root, input.replace(/^@/, ""));
  const candidateReal = await resolveThroughExistingParent(candidate);
  const fromRoot = relative(rootReal, candidateReal);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(rootReal, fromRoot) !== candidateReal
  ) {
    throw new Error(`Path resolves outside the procedure project: ${input}`);
  }
  const parts = fromRoot.split(sep).filter(Boolean);
  if (options.mutation && parts.includes(".git")) {
    throw new Error("Procedure agents may not modify Git metadata.");
  }
  return fromRoot ? `./${fromRoot.split(sep).join("/")}` : ".";
}

export function terminalText(value: unknown, maximum = 500): string {
  let result = "";
  for (const character of String(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && (code < 127 || code > 159))) {
      result += character;
    }
    if (result.length >= maximum) break;
  }
  return result.slice(0, maximum);
}
