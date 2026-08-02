import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { ReviewTargetSnapshot } from "./models.ts";

export type ExecGit = (
  command: string,
  args: string[],
  options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
) => Promise<ExecResult>;

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type StreamGit = (
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
  onStdout: (chunk: Buffer) => void,
) => Promise<GitCommandResult>;

const STREAM_STDERR_LIMIT = 64 * 1024;
export const GIT_STATUS_MAX_BYTES = 1024 * 1024;

const streamGit: StreamGit = (args, options, onStdout) =>
  new Promise<GitCommandResult>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = Buffer.alloc(0);
    let consumerError: unknown;
    let settled = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (consumerError) return;
      try {
        onStdout(chunk);
      } catch (error) {
        consumerError = error;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stderr.length > STREAM_STDERR_LIMIT) {
        stderr = stderr.subarray(stderr.length - STREAM_STDERR_LIMIT);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(consumerError ?? error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (consumerError) reject(consumerError);
      else
        resolvePromise({
          stdout: "",
          stderr: stderr.toString("utf8"),
          code: code ?? -1,
        });
    });
  });

export class GitClient {
  private readonly execute: ExecGit;
  readonly cwd: string;
  private readonly signal?: AbortSignal;
  private readonly streamExecute: StreamGit;

  constructor(execute: ExecGit, cwd: string, signal?: AbortSignal, streamExecute = streamGit) {
    this.execute = execute;
    this.cwd = cwd;
    this.signal = signal;
    this.streamExecute = streamExecute;
  }

  async run(
    args: string[],
    options: { allowFailure?: boolean; cwd?: string } = {},
  ): Promise<GitCommandResult> {
    if (this.signal?.aborted) throw abortError();
    const result = await this.execute("git", args, {
      cwd: options.cwd ?? this.cwd,
      signal: this.signal,
    });
    if (!options.allowFailure && result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  async stream(
    args: string[],
    onStdout: (chunk: Buffer) => void,
    options: { allowFailure?: boolean; cwd?: string } = {},
  ): Promise<GitCommandResult> {
    if (this.signal?.aborted) throw abortError();
    const result = await this.streamExecute(
      args,
      { cwd: options.cwd ?? this.cwd, signal: this.signal },
      onStdout,
    );
    if (!options.allowFailure && result.code !== 0) {
      const detail = result.stderr.trim();
      throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  async repositoryRoot(): Promise<string> {
    const result = await this.run(["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    if (!root) throw new Error("Not a Git repository.");
    return root;
  }

  async head(): Promise<string> {
    const result = await this.run(["rev-parse", "HEAD"]);
    return result.stdout.trim();
  }

  async branch(): Promise<string | undefined> {
    const result = await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      allowFailure: true,
    });
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  get abortSignal(): AbortSignal | undefined {
    return this.signal;
  }

  async status(): Promise<string> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    await this.stream(
      ["-c", "core.quotePath=false", "status", "--short", "--untracked-files=all"],
      (chunk) => {
        bytes += chunk.length;
        if (bytes > GIT_STATUS_MAX_BYTES) {
          throw new Error(
            `Git status exceeds the ${GIT_STATUS_MAX_BYTES / (1024 * 1024)} MiB safety limit.`,
          );
        }
        chunks.push(Buffer.from(chunk));
      },
    );
    return Buffer.concat(chunks, bytes).toString("utf8");
  }
}

export function abortError(message = "Review loop aborted."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function normalizeRepositoryPath(repositoryRoot: string, input: string): string {
  if (!input.trim()) throw new Error("Path must not be empty.");
  if (isAbsolute(input)) throw new Error(`Path must be relative to the repository: ${input}`);
  const absolute = resolve(repositoryRoot, input);
  const relativePath = relative(repositoryRoot, absolute);
  if (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  ) {
    return relativePath === "" ? "." : relativePath.split(sep).join("/");
  }
  throw new Error(`Path escapes the repository: ${input}`);
}

export function pathIsInScope(path: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => {
    if (scope === ".") return true;
    return path === scope || path.startsWith(`${scope}/`);
  });
}

function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function isMissingFilesystemPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFilesystemPath(error)) return undefined;
    throw error;
  }
}

const OTHER_FILE_LIST_MAX_BYTES = 16 * 1024 * 1024;
const DIFF_STAT_MAX_BYTES = 1024 * 1024;

export async function cappedGitText(
  git: GitClient,
  repositoryRoot: string,
  args: string[],
  maxBytes: number,
  description: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  await git.stream(
    args,
    (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`${description} exceeds its byte safety limit.`);
      chunks.push(Buffer.from(chunk));
    },
    { cwd: repositoryRoot },
  );
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function otherFiles(
  git: GitClient,
  repositoryRoot: string,
  ignored: boolean,
  maxFiles = Number.POSITIVE_INFINITY,
  collapseDirectories = false,
): Promise<string[]> {
  const args = ["-c", "core.quotePath=false", "ls-files", "--others"];
  if (ignored) args.push("--ignored");
  if (collapseDirectories) args.push("--directory", "--no-empty-directory");
  args.push("--exclude-standard", "-z");
  const files: string[] = [];
  let pending = Buffer.alloc(0);
  let outputBytes = 0;
  await git.stream(
    args,
    (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > OTHER_FILE_LIST_MAX_BYTES) {
        throw new Error("Git file listing exceeds its byte safety limit.");
      }
      pending = Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator >= 0) {
        if (separator > 0) files.push(pending.subarray(0, separator).toString("utf8"));
        if (files.length > maxFiles) {
          throw new Error(
            `${ignored ? "Ignored" : "Untracked"} file count exceeds its ${maxFiles}-file safety limit.`,
          );
        }
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
    },
    { cwd: repositoryRoot },
  );
  if (pending.length > 0) {
    throw new Error("Git returned an unterminated file listing.");
  }
  return files.sort();
}

export const UNTRACKED_PATCH_MAX_FILES = 1_000;

export async function listUntrackedFiles(
  git: GitClient,
  repositoryRoot: string,
  maxFiles = UNTRACKED_PATCH_MAX_FILES,
): Promise<string[]> {
  return otherFiles(git, repositoryRoot, false, maxFiles);
}

export const TARGET_DIFF_MAX_BYTES = 8 * 1024 * 1024;
const TARGET_DIFF_LIMIT_MESSAGE = `Target diff exceeds the ${TARGET_DIFF_MAX_BYTES / (1024 * 1024)} MiB safety limit.`;

function assertDiffExitCode(result: GitCommandResult, allowedExitCodes: readonly number[]): void {
  if (allowedExitCodes.includes(result.code)) return;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`Could not generate diff${detail ? `: ${detail}` : "."}`);
}

class DirtySubmoduleDiffDetector {
  private pending = "";
  private sawSubmoduleMetadata = false;

  update(chunk: Buffer): void {
    this.pending += chunk.toString("utf8");
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      this.inspectLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
  }

  finish(): void {
    if (this.pending) this.inspectLine(this.pending);
    this.pending = "";
  }

  private inspectLine(line: string): void {
    if (line.startsWith("diff --git ")) {
      this.sawSubmoduleMetadata = false;
      return;
    }
    if (
      /^(?:new file mode|deleted file mode|old mode|new mode) 160000$/.test(line) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/i.test(line)
    ) {
      this.sawSubmoduleMetadata = true;
      return;
    }
    if (/^\+Subproject commit [0-9a-f]{40,64}-dirty$/i.test(line) && this.sawSubmoduleMetadata) {
      throw new Error(
        "Review target contains a dirty submodule worktree. Clean its tracked and untracked changes before review.",
      );
    }
  }
}

function assertNoDirtySubmoduleDiff(diff: string): void {
  const detector = new DirtySubmoduleDiffDetector();
  detector.update(Buffer.from(diff));
  detector.finish();
}

async function cappedGitDiff(
  git: GitClient,
  repositoryRoot: string,
  args: string[],
  maxBytes: number,
  allowedExitCodes: readonly number[] = [0],
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const result = await git.stream(
    args,
    (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) throw new Error(TARGET_DIFF_LIMIT_MESSAGE);
      chunks.push(Buffer.from(chunk));
    },
    { allowFailure: true, cwd: repositoryRoot },
  );
  assertDiffExitCode(result, allowedExitCodes);
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function quoteDiffPath(prefix: "a/" | "b/", path: string): string {
  const bytes = Buffer.from(`${prefix}${path}`);
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte <= 0x7e) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

async function readPatchFile(
  absolutePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stream = createReadStream(absolutePath, { signal });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        stream.destroy(new Error(TARGET_DIFF_LIMIT_MESSAGE));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(Buffer.concat(chunks, bytes)));
  });
}

function untrackedFilePatch(path: string, mode: string, content: Buffer): string {
  const aPath = quoteDiffPath("a/", path);
  const bPath = quoteDiffPath("b/", path);
  const lines = [`diff --git ${aPath} ${bPath}`, `new file mode ${mode}`];
  let text: string | undefined;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    // Invalid UTF-8 is represented as binary metadata rather than decoded lossy content.
  }
  if (text === undefined || content.includes(0)) {
    lines.push(
      `Binary files /dev/null and ${bPath} differ`,
      `binary sha256 ${createHash("sha256").update(content).digest("hex")}`,
    );
    return lines.join("\n");
  }

  lines.push("--- /dev/null", `+++ ${bPath}`);
  if (text.length === 0) return lines.join("\n");
  const hasFinalNewline = text.endsWith("\n");
  const added = text.split("\n");
  if (hasFinalNewline) added.pop();
  lines.push(`@@ -0,0 +1,${added.length} @@`, ...added.map((line) => `+${line}`));
  if (!hasFinalNewline) lines.push("\\ No newline at end of file");
  return lines.join("\n");
}

async function targetUntrackedFiles(
  git: GitClient,
  target: ReviewTargetSnapshot,
): Promise<string[]> {
  const files = new Set(
    await listUntrackedFiles(git, target.repositoryRoot, UNTRACKED_PATCH_MAX_FILES),
  );
  const frozenPaths = [
    ...(target.initialUntrackedPaths ?? []),
    ...(target.retainedUntrackedPaths ?? []),
  ];
  for (const path of frozenPaths) {
    const normalized = normalizeRepositoryPath(target.repositoryRoot, path);
    if (!files.has(normalized)) {
      if (git.abortSignal?.aborted) throw abortError();
      if (!(await lstatIfPresent(resolve(target.repositoryRoot, normalized)))) continue;
    }
    files.add(normalized);
    if (files.size > UNTRACKED_PATCH_MAX_FILES) {
      throw new Error(
        `Untracked file count exceeds its ${UNTRACKED_PATCH_MAX_FILES}-file safety limit.`,
      );
    }
  }
  return [...files].sort();
}

async function untrackedPatch(
  git: GitClient,
  target: ReviewTargetSnapshot,
  maxBytes: number,
): Promise<string> {
  const repositoryRoot = target.repositoryRoot;
  const patches: string[] = [];
  let totalBytes = 0;
  for (const file of await targetUntrackedFiles(git, target)) {
    if (git.abortSignal?.aborted) throw abortError();
    const absolute = resolve(repositoryRoot, file);
    const stat = await lstatIfPresent(absolute);
    if (!stat) throw new Error(`Untracked file disappeared while generating diff: ${file}`);
    let content: Buffer;
    let mode: string;
    if (stat.isSymbolicLink()) {
      if (git.abortSignal?.aborted) throw abortError();
      const destination = await readlink(absolute);
      if (git.abortSignal?.aborted) throw abortError();
      content = Buffer.from(destination);
      mode = "120000";
    } else if (stat.isFile()) {
      if (stat.size > maxBytes - totalBytes) throw new Error(TARGET_DIFF_LIMIT_MESSAGE);
      content = await readPatchFile(absolute, maxBytes - totalBytes, git.abortSignal);
      mode = stat.mode & 0o111 ? "100755" : "100644";
    } else {
      throw new Error(`Unsupported untracked filesystem entry: ${file}`);
    }
    const patch = untrackedFilePatch(file, mode, content);
    totalBytes += Buffer.byteLength(patch) + (patches.length > 0 ? 1 : 0);
    if (totalBytes > maxBytes) throw new Error(TARGET_DIFF_LIMIT_MESSAGE);
    patches.push(patch);
  }
  return patches.join("\n");
}

export async function getTargetDiff(
  git: GitClient,
  target: ReviewTargetSnapshot,
  contextLines = 3,
): Promise<string> {
  if (target.type === "folder") return "";
  if (!target.baseSha) throw new Error("Diff target is missing its frozen base SHA.");
  const diffOptions = [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--binary",
    `--unified=${contextLines}`,
  ];
  const parts: string[] = [];
  let totalBytes = 0;
  const addPart = (part: string) => {
    if (!part) return;
    totalBytes += Buffer.byteLength(part) + (parts.length > 0 ? 1 : 0);
    if (totalBytes > TARGET_DIFF_MAX_BYTES) throw new Error(TARGET_DIFF_LIMIT_MESSAGE);
    parts.push(part);
  };
  const baseToWorktree = await cappedGitDiff(
    git,
    target.repositoryRoot,
    ["-c", "core.quotePath=false", "diff", ...diffOptions, target.baseSha, "--"],
    TARGET_DIFF_MAX_BYTES - totalBytes,
  );
  assertNoDirtySubmoduleDiff(baseToWorktree);
  addPart(baseToWorktree);
  addPart(await untrackedPatch(git, target, TARGET_DIFF_MAX_BYTES - totalBytes));
  return parts.join("\n");
}

export async function getChangedFiles(
  git: GitClient,
  target: ReviewTargetSnapshot,
): Promise<string[]> {
  if (target.type === "folder") return [...(target.paths ?? [])];
  if (!target.baseSha) throw new Error("Diff target is missing its frozen base SHA.");
  const options = [
    "--name-only",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
    "-z",
  ];
  const [baseToWorktree, untracked] = await Promise.all([
    cappedGitText(
      git,
      target.repositoryRoot,
      ["-c", "core.quotePath=false", "diff", ...options, target.baseSha, "--"],
      OTHER_FILE_LIST_MAX_BYTES,
      "Git changed-file listing",
    ),
    targetUntrackedFiles(git, target),
  ]);
  return [...new Set([...splitNull(baseToWorktree), ...untracked])].sort();
}

export async function getDiffStat(git: GitClient, target: ReviewTargetSnapshot): Promise<string> {
  if (target.type === "folder") {
    return `Snapshot paths: ${(target.paths ?? []).join(", ")}`;
  }
  if (!target.baseSha) throw new Error("Diff target is missing its frozen base SHA.");
  const options = [
    "--stat",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=none",
    "--submodule=short",
  ];
  const [baseToWorktree, untracked] = await Promise.all([
    cappedGitText(
      git,
      target.repositoryRoot,
      ["-c", "core.quotePath=false", "diff", ...options, target.baseSha, "--"],
      DIFF_STAT_MAX_BYTES,
      "Git diff stat",
    ),
    targetUntrackedFiles(git, target),
  ]);
  return [
    baseToWorktree.trim()
      ? `Base to worktree:\n${baseToWorktree.trimEnd()}`
      : "Base to worktree: (empty)",
    untracked.length > 0 ? `Untracked files: ${untracked.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
export const SNAPSHOT_FILE_LIST_MAX_BYTES = 16 * 1024 * 1024;

export interface SnapshotFingerprintOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
}

interface SnapshotTraversalState {
  readonly signal?: AbortSignal;
  readonly maxFiles: number;
  entries: number;
}

function assertSnapshotActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Folder snapshot aborted.");
}

function snapshotLimitError(kind: "file-count" | "byte"): Error {
  return new Error(`Folder snapshot exceeds its ${kind} safety limit.`);
}

async function hashFile(
  hash: ReturnType<typeof createHash>,
  absolutePath: string,
  maximumBytes = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
  byteLimitError: () => Error = () => snapshotLimitError("byte"),
): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    let bytes = 0;
    const stream = createReadStream(absolutePath, { signal });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        stream.destroy(byteLimitError());
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(bytes));
  });
}

function addSnapshotFile(files: Set<string>, file: string, state: SnapshotTraversalState): void {
  if (files.has(file)) return;
  files.add(file);
  if (files.size > state.maxFiles) throw snapshotLimitError("file-count");
}

async function collectDirectoryFiles(
  repositoryRoot: string,
  directory: string,
  files: Set<string>,
  state: SnapshotTraversalState,
  ignoredPaths?: ReadonlySet<string>,
): Promise<void> {
  assertSnapshotActive(state.signal);
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    assertSnapshotActive(state.signal);
    const child = directory === "." ? entry.name : `${directory}/${entry.name}`;
    if (entry.name.toLowerCase() === ".git") {
      const fromRoot = relative(repositoryRoot, resolve(repositoryRoot, child));
      if (fromRoot.toLowerCase() === ".git") continue;
      throw new Error(`Folder snapshot contains nested Git metadata: ${child}`);
    }
    if (ignoredPaths?.has(child)) continue;
    state.entries += 1;
    if (state.entries > state.maxFiles) throw snapshotLimitError("file-count");
    if (entry.isDirectory()) {
      await collectDirectoryFiles(repositoryRoot, child, files, state, ignoredPaths);
    } else {
      addSnapshotFile(files, child, state);
    }
  }
}

async function listIgnoredSnapshotPaths(
  git: GitClient,
  repositoryRoot: string,
  scopes: readonly string[],
  state: SnapshotTraversalState,
): Promise<Set<string>> {
  const ignored = new Set<string>();
  let pending = Buffer.alloc(0);
  let outputBytes = 0;
  await git.stream(
    [
      "--literal-pathspecs",
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--ignored=matching",
      "--untracked-files=normal",
      "--",
      ...scopes,
    ],
    (chunk) => {
      assertSnapshotActive(state.signal);
      outputBytes += chunk.length;
      if (outputBytes > SNAPSHOT_FILE_LIST_MAX_BYTES) {
        throw new Error("Folder snapshot ignored-path listing exceeds its byte safety limit.");
      }
      pending = Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator >= 0) {
        const entry = pending.subarray(0, separator).toString("utf8");
        if (entry.startsWith("!! ")) {
          ignored.add(entry.slice(3).replace(/\/$/, ""));
        }
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
    },
    { cwd: repositoryRoot },
  );
  if (pending.length > 0) {
    throw new Error("Git returned an unterminated ignored-path listing.");
  }
  return ignored;
}

async function snapshotScopeIsIgnored(
  git: GitClient,
  repositoryRoot: string,
  scope: string,
): Promise<boolean> {
  const result = await git.run(["check-ignore", "--no-index", "--quiet", "--", scope], {
    allowFailure: true,
    cwd: repositoryRoot,
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`Could not check folder snapshot ignore rules${detail ? `: ${detail}` : "."}`);
}

async function listSnapshotFiles(
  git: GitClient,
  repositoryRoot: string,
  scopes: readonly string[],
  state: SnapshotTraversalState,
): Promise<string[]> {
  assertSnapshotActive(state.signal);
  const files = new Set<string>();
  let pending = Buffer.alloc(0);
  let outputBytes = 0;
  await git.stream(
    [
      "--literal-pathspecs",
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...scopes,
    ],
    (chunk) => {
      assertSnapshotActive(state.signal);
      outputBytes += chunk.length;
      if (outputBytes > SNAPSHOT_FILE_LIST_MAX_BYTES) {
        throw new Error("Folder snapshot file listing exceeds its byte safety limit.");
      }
      pending = Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator >= 0) {
        if (separator > 0) {
          addSnapshotFile(files, pending.subarray(0, separator).toString("utf8"), state);
        }
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
    },
    { cwd: repositoryRoot },
  );
  if (pending.length > 0) throw new Error("Git returned an unterminated snapshot file listing.");

  const ignoredPaths = await listIgnoredSnapshotPaths(git, repositoryRoot, scopes, state);
  // Walk selected directories to catch filesystem races and nested Git metadata. Ignore excluded
  // descendants of ordinary scopes, but include them when the selected scope itself is ignored.
  for (const scope of scopes) {
    assertSnapshotActive(state.signal);
    const absolute = resolve(repositoryRoot, scope);
    const stat = await lstatIfPresent(absolute);
    if (stat?.isFile() || stat?.isSymbolicLink()) addSnapshotFile(files, scope, state);
    else if (stat?.isDirectory()) {
      const explicitlyIgnored = await snapshotScopeIsIgnored(git, repositoryRoot, scope);
      await collectDirectoryFiles(
        repositoryRoot,
        scope,
        files,
        state,
        explicitlyIgnored ? undefined : ignoredPaths,
      );
    }
  }
  return [...files].sort();
}

function updateScopeMetadata(
  hash: ReturnType<typeof createHash>,
  normalized: string,
  stat: Awaited<ReturnType<typeof lstat>> | undefined,
): void {
  hash.update(`scope\0${normalized}\0`);
  if (!stat) hash.update("missing\0");
  else if (stat.isSymbolicLink()) hash.update(`symlink\0${stat.mode}\0`);
  else if (stat.isFile()) hash.update(`file\0${stat.mode}\0${stat.size}\0`);
  else if (stat.isDirectory()) hash.update(`directory\0${stat.mode}\0`);
  else hash.update(`other\0${stat.mode}\0`);
}

export async function snapshotFingerprint(
  git: GitClient,
  repositoryRoot: string,
  scopes: readonly string[],
  options: SnapshotFingerprintOptions = {},
): Promise<string> {
  const signal = options.signal ?? git.abortSignal;
  const maxFiles = options.maxFiles ?? SNAPSHOT_MAX_FILES;
  const maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
  const state: SnapshotTraversalState = { signal, maxFiles, entries: 0 };
  const hash = createHash("sha256");
  for (const scope of scopes) {
    assertSnapshotActive(signal);
    const normalized = normalizeRepositoryPath(repositoryRoot, scope);
    const stat = await lstatIfPresent(resolve(repositoryRoot, normalized));
    updateScopeMetadata(hash, normalized, stat);
  }

  let totalBytes = 0;
  for (const file of await listSnapshotFiles(git, repositoryRoot, scopes, state)) {
    assertSnapshotActive(signal);
    const normalized = normalizeRepositoryPath(repositoryRoot, file);
    const absolute = resolve(repositoryRoot, normalized);
    const stat = await lstatIfPresent(absolute);
    hash.update(`path\0${normalized}\0`);
    if (!stat) {
      hash.update("missing\0");
    } else if (stat.isSymbolicLink()) {
      const destination = await readlink(absolute);
      totalBytes += Buffer.byteLength(destination);
      if (totalBytes > maxBytes) throw snapshotLimitError("byte");
      hash.update(`symlink\0${destination}\0`);
    } else if (stat.isFile()) {
      if (stat.size > maxBytes - totalBytes) throw snapshotLimitError("byte");
      hash.update(`file\0${stat.mode}\0${stat.size}\0`);
      totalBytes += await hashFile(hash, absolute, maxBytes - totalBytes, signal);
      hash.update("\0");
    } else {
      hash.update(`other\0${stat.mode}\0`);
    }
  }
  return hash.digest("hex");
}

export async function targetFingerprint(
  git: GitClient,
  target: ReviewTargetSnapshot,
): Promise<string> {
  if (target.type === "folder") {
    return snapshotFingerprint(git, target.repositoryRoot, target.paths ?? []);
  }
  const hash = createHash("sha256");
  hash.update(`base\0${target.baseSha ?? ""}\0`);
  hash.update(await getTargetDiff(git, target, 0));
  return hash.digest("hex");
}

export const REPOSITORY_FINGERPRINT_MAX_FILES = 20_000;
export const REPOSITORY_FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;
const IGNORED_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;
const IGNORED_FINGERPRINT_TOTAL_SAMPLE_BYTES = 4 * 1024 * 1024;

export interface RepositoryFingerprintOptions {
  signal?: AbortSignal;
  maxFiles?: number;
  maxBytes?: number;
}

interface FingerprintBudget {
  readonly signal?: AbortSignal;
  readonly maxFiles: number;
  readonly maxBytes: number;
  files: number;
  bytes: number;
  ignoredBytes: number;
}

function fingerprintLimitError(kind: "file-count" | "byte"): Error {
  return new Error(`Repository fingerprint exceeds its ${kind} safety limit.`);
}

function assertFingerprintActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Repository fingerprint aborted.");
}

function consumeFingerprintBytes(state: FingerprintBudget, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > state.maxBytes) throw fingerprintLimitError("byte");
}

async function hashFilePrefix(
  hash: ReturnType<typeof createHash>,
  absolutePath: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  if (maximumBytes <= 0) return 0;
  return new Promise<number>((resolvePromise, reject) => {
    let bytes = 0;
    const stream = createReadStream(absolutePath, { end: maximumBytes - 1, signal });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(bytes));
  });
}

async function hashGitDiff(
  hash: ReturnType<typeof createHash>,
  git: GitClient,
  repositoryRoot: string,
  args: string[],
  state: FingerprintBudget,
): Promise<void> {
  const detector = new DirtySubmoduleDiffDetector();
  const result = await git.stream(
    args,
    (chunk) => {
      assertFingerprintActive(state.signal);
      detector.update(chunk);
      consumeFingerprintBytes(state, chunk.length);
      hash.update(chunk);
    },
    { allowFailure: true, cwd: repositoryRoot },
  );
  detector.finish();
  assertDiffExitCode(result, [0]);
}

async function hashExtraWorktreeFiles(
  hash: ReturnType<typeof createHash>,
  git: GitClient,
  repositoryRoot: string,
  state: FingerprintBudget,
  scopes?: readonly string[],
): Promise<void> {
  const [untracked, ignoredRoots, ignored] = await Promise.all([
    listUntrackedFiles(git, repositoryRoot, state.maxFiles),
    otherFiles(git, repositoryRoot, true, state.maxFiles, true),
    // Enumerate ignored descendants so an existing child's content cannot change behind an
    // unchanged parent-directory timestamp. Count collapsed ignored trees against the file budget
    // while the listing-byte and sampling-byte budgets bound their descendant traversal.
    otherFiles(git, repositoryRoot, true),
  ]);
  const countedFiles = new Set([
    ...untracked.filter((file) => !scopes || !pathIsInScope(file, scopes)),
    ...ignoredRoots.filter((file) => !scopes || !pathIsInScope(file, scopes)),
  ]);
  state.files += countedFiles.size;
  if (state.files > state.maxFiles) throw fingerprintLimitError("file-count");

  const files = new Map<string, "untracked" | "ignored">();
  for (const file of untracked) files.set(file, "untracked");
  for (const file of ignored) files.set(file, "ignored");

  for (const [file, kind] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    if (scopes && pathIsInScope(file, scopes)) continue;
    assertFingerprintActive(state.signal);
    const normalized = normalizeRepositoryPath(repositoryRoot, file);
    const absolute = resolve(repositoryRoot, normalized);
    const fileStat = await lstatIfPresent(absolute);
    hash.update(`${kind}\0${normalized}\0`);
    if (!fileStat) {
      hash.update("missing\0");
      continue;
    }
    if (fileStat.isFile()) {
      hash.update(`file\0${fileStat.mode}\0${fileStat.size}\0${fileStat.mtimeMs}\0`);
      if (kind === "ignored") {
        const sampleBytes = Math.min(
          fileStat.size,
          IGNORED_FINGERPRINT_SAMPLE_BYTES,
          Math.max(0, IGNORED_FINGERPRINT_TOTAL_SAMPLE_BYTES - state.ignoredBytes),
        );
        hash.update(`sample\0${sampleBytes}\0`);
        state.ignoredBytes += await hashFilePrefix(hash, absolute, sampleBytes, state.signal);
      } else {
        if (fileStat.size > state.maxBytes - state.bytes) {
          throw fingerprintLimitError("byte");
        }
        state.bytes += await hashFile(
          hash,
          absolute,
          state.maxBytes - state.bytes,
          state.signal,
          () => fingerprintLimitError("byte"),
        );
      }
    } else if (fileStat.isSymbolicLink()) {
      assertFingerprintActive(state.signal);
      const destination = await readlink(absolute);
      assertFingerprintActive(state.signal);
      if (kind === "ignored") state.ignoredBytes += Buffer.byteLength(destination);
      else consumeFingerprintBytes(state, Buffer.byteLength(destination));
      hash.update(`symlink\0${destination}`);
    } else if (fileStat.isDirectory()) {
      hash.update(`directory\0${fileStat.mode}\0${fileStat.size}\0${fileStat.mtimeMs}`);
    } else {
      hash.update(`other\0${fileStat.mode}\0${fileStat.size}\0${fileStat.mtimeMs}`);
    }
    hash.update("\0");
  }
}

function fingerprintBudget(
  git: GitClient,
  options: RepositoryFingerprintOptions,
): FingerprintBudget {
  return {
    signal: options.signal ?? git.abortSignal,
    maxFiles: options.maxFiles ?? REPOSITORY_FINGERPRINT_MAX_FILES,
    maxBytes: options.maxBytes ?? REPOSITORY_FINGERPRINT_MAX_BYTES,
    files: 0,
    bytes: 0,
    ignoredBytes: 0,
  };
}

export async function repositoryFingerprint(
  git: GitClient,
  repositoryRoot: string,
  options: RepositoryFingerprintOptions = {},
): Promise<string> {
  const state = fingerprintBudget(git, options);
  assertFingerprintActive(state.signal);
  const head = (await git.run(["rev-parse", "HEAD"], { cwd: repositoryRoot })).stdout.trim();
  const hash = createHash("sha256");
  hash.update(`head\0${head}\0`);
  await git.stream(
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z"],
    (chunk) => {
      assertFingerprintActive(state.signal);
      consumeFingerprintBytes(state, chunk.length);
      hash.update(chunk);
    },
    { cwd: repositoryRoot },
  );
  const diffOptions = [
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--submodule=short",
  ];
  hash.update("cached\0");
  await hashGitDiff(
    hash,
    git,
    repositoryRoot,
    ["-c", "core.quotePath=false", "diff", "--cached", ...diffOptions, "HEAD", "--"],
    state,
  );
  hash.update("\0unstaged\0");
  await hashGitDiff(
    hash,
    git,
    repositoryRoot,
    ["-c", "core.quotePath=false", "diff", ...diffOptions, "--"],
    state,
  );
  hash.update("\0");
  await hashExtraWorktreeFiles(hash, git, repositoryRoot, state);
  return hash.digest("hex");
}

export async function outsideScopeFingerprint(
  git: GitClient,
  repositoryRoot: string,
  scopes: readonly string[],
  options: RepositoryFingerprintOptions = {},
): Promise<string> {
  const hash = createHash("sha256");
  const exclusions = scopes
    .filter((scope) => scope !== ".")
    .map((scope) => `:(exclude,literal)${scope}`);
  if (scopes.includes(".")) return hash.update("whole-repository-in-scope").digest("hex");
  const state = fingerprintBudget(git, options);
  assertFingerprintActive(state.signal);
  const diffOptions = [
    "--binary",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
    "--submodule=short",
  ];
  const paths = ["--", ".", ...exclusions];
  hash.update("cached\0");
  await hashGitDiff(
    hash,
    git,
    repositoryRoot,
    ["-c", "core.quotePath=false", "diff", "--cached", ...diffOptions, "HEAD", ...paths],
    state,
  );
  hash.update("\0unstaged\0");
  await hashGitDiff(
    hash,
    git,
    repositoryRoot,
    ["-c", "core.quotePath=false", "diff", ...diffOptions, ...paths],
    state,
  );
  hash.update("\0");
  await hashExtraWorktreeFiles(hash, git, repositoryRoot, state, scopes);
  return hash.digest("hex");
}

export interface ChangedLineMap {
  [path: string]: Set<number>;
}

function unquoteDiffPath(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
  const content = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const escapedBytes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (character !== "\\") {
      const literal = String.fromCodePoint(content.codePointAt(index)!);
      bytes.push(...Buffer.from(literal));
      index += literal.length - 1;
      continue;
    }

    const escaped = content[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      break;
    }
    index += 1;
    if (/^[0-7]$/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /^[0-7]$/.test(content[index + 1] ?? "")) {
        octal += content[index + 1];
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const decoded = escapedBytes[escaped];
    if (decoded === undefined) bytes.push(0x5c, ...Buffer.from(escaped));
    else bytes.push(decoded);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse added lines and defined current/adjacent locations for deletions. */
export function parseChangedLines(
  diff: string,
  changedFiles: readonly string[] = [],
): ChangedLineMap {
  const result = Object.create(null) as ChangedLineMap;
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let hunk:
    | {
        oldLine: number;
        newLine: number;
        newStart: number;
        newEnd: number;
        path: string;
      }
    | undefined;

  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        hunk = undefined;
        continue;
      }
      const oldStart = Number(match[1]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      const path = newPath ?? oldPath;
      hunk = path
        ? {
            oldLine: oldStart,
            newLine: newStart,
            newStart,
            newEnd: newStart + newCount - 1,
            path,
          }
        : undefined;
      continue;
    }

    if (hunk) {
      const lines = (result[hunk.path] ??= new Set<number>());
      if (line.startsWith("+")) {
        lines.add(hunk.newLine);
        hunk.newLine += 1;
        continue;
      }
      if (line.startsWith("-")) {
        if (!newPath) {
          lines.add(hunk.oldLine);
        } else if (hunk.newEnd < hunk.newStart) {
          // In a zero-count range, Git's newStart identifies the surviving line adjacent to
          // the deletion (or zero when the current file is empty).
          lines.add(Math.max(1, hunk.newStart));
        } else {
          lines.add(Math.max(hunk.newStart, Math.min(hunk.newLine, hunk.newEnd)));
        }
        hunk.oldLine += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        hunk.oldLine += 1;
        hunk.newLine += 1;
        continue;
      }
      if (line.startsWith("\\ No newline at end of file")) continue;
      hunk = undefined;
    }

    if (line.startsWith("--- ")) {
      const value = unquoteDiffPath(line.slice(4));
      oldPath = value === "/dev/null" ? undefined : value.replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = unquoteDiffPath(line.slice(4));
      newPath = value === "/dev/null" ? undefined : value.replace(/^b\//, "");
    }
  }
  // Binary, mode-only, gitlink, and other metadata-only changes have no textual hunks. The
  // host's NUL-delimited changed-file list supplies a synthetic file-level location for them.
  for (const path of changedFiles) {
    result[path] ??= new Set([1]);
  }
  return result;
}

export function lineRangeOverlaps(
  changedLines: ChangedLineMap,
  path: string,
  startLine: number,
  endLine: number,
): boolean {
  const lines = changedLines[path];
  if (!lines) return false;
  for (let line = startLine; line <= endLine; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

export async function listLocalBranches(git: GitClient): Promise<string[]> {
  const result = await git.run(["branch", "--format=%(refname:short)"]);
  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function listRecentCommits(
  git: GitClient,
  limit = 20,
): Promise<Array<{ sha: string; title: string }>> {
  const result = await git.run(["log", `--max-count=${limit}`, "--format=%H%x00%s"]);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\0");
      return separator < 0
        ? { sha: line.trim(), title: "" }
        : { sha: line.slice(0, separator), title: line.slice(separator + 1) };
    });
}

export async function defaultBranch(git: GitClient): Promise<string | undefined> {
  const branches = await listLocalBranches(git);
  const remote = await git.run(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
    allowFailure: true,
  });
  const remoteBranch = remote.stdout.trim().replace(/^origin\//, "");
  if (remote.code === 0 && branches.includes(remoteBranch)) return remoteBranch;
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  const current = await git.branch();
  return current && branches.includes(current) ? current : branches[0];
}

export async function directoryHasEntries(path: string): Promise<boolean> {
  const entries = await readdir(path).catch(() => []);
  return entries.length > 0;
}
