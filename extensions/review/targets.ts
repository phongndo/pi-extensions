import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadProjectContextFiles, type ExecResult } from "@earendil-works/pi-coding-agent";
import {
  abortError,
  defaultBranch,
  getChangedFiles,
  GitClient,
  listUntrackedFiles,
  listLocalBranches,
  normalizeRepositoryPath,
  type ExecGit,
} from "./git.ts";
import type { ReviewTargetRequest, ReviewTargetSnapshot } from "./models.ts";
import {
  nearbyGitMetadataRealPaths,
  repositoryPathHasGitMetadataComponent,
  repositoryRootGitMetadataRealPaths,
  resolvedPathHasGitMetadataComponent,
  resolvedPathIsWithin,
  type GitMetadataPathCache,
} from "./path-safety.ts";

export const GH_SETUP_INSTRUCTIONS =
  "Install GitHub CLI (`gh`) from https://cli.github.com/, run `gh auth login`, then verify with `gh auth status`.";
export const PR_DIRTY_MESSAGE =
  "Cannot check out a pull request while tracked, untracked, or ignored files are present. Commit, stash, or remove them first.";
export const COMMIT_DIRTY_MESSAGE =
  "Commit review requires a clean worktree. Commit, stash, or remove staged, unstaged, and untracked changes first.";
export const STAGED_CHANGES_MESSAGE =
  "Review targets do not support staged changes because fixer tools can only modify working-tree files. Unstage the changes before starting the review loop.";

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

export interface ResolveTargetOptions {
  cwd: string;
  execute: ExecGit;
  signal?: AbortSignal;
  notify?: Notify;
}

function shortError(result: Pick<ExecResult, "stderr" | "stdout">): string {
  return (result.stderr || result.stdout).trim();
}

async function executeChecked(
  execute: ExecGit,
  command: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; allowFailure?: boolean },
): Promise<ExecResult> {
  const result = await execute(command, args, { cwd: options.cwd, signal: options.signal });
  if (!options.allowFailure && result.code !== 0) {
    const detail = shortError(result);
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function resolveCommit(git: GitClient, revision: string): Promise<string> {
  const result = await git.run(["rev-parse", "--verify", `${revision}^{commit}`], {
    allowFailure: true,
  });
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`Unknown commit or revision: ${revision}`);
  }
  return result.stdout.trim();
}

async function resolveMergeBase(
  git: GitClient,
  head: string,
  branchSha: string,
  branch: string,
): Promise<string> {
  const result = await git.run(["merge-base", head, branchSha], { allowFailure: true });
  if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
  throw new Error(`Could not determine a merge base between HEAD and ${branch}.`);
}

interface ParsedPrReference {
  number: number;
  ghReference: string;
}

function parsePrReference(reference: string): ParsedPrReference {
  const trimmed = reference.trim();
  if (/^[1-9]\d*$/.test(trimmed)) {
    return { number: Number(trimmed), ghReference: trimmed };
  }
  const match = trimmed.match(
    /^(?:https?:\/\/)?github\.com\/[^/]+\/[^/]+\/pull\/([1-9]\d*)(?:[/?#].*)?$/i,
  );
  if (!match)
    throw new Error("Invalid pull-request reference. Use a PR number or GitHub pull-request URL.");
  return {
    number: Number(match[1]),
    ghReference: /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
  };
}

interface PrInfo {
  baseRefName: string;
  baseRefOid: string;
  baseRepository: string;
  headRefName: string;
  headRefOid: string;
  title: string;
}

function parseRepositoryNameWithOwner(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("nameWithOwner" in parsed) ||
    typeof parsed.nameWithOwner !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(parsed.nameWithOwner)
  ) {
    return undefined;
  }
  return parsed.nameWithOwner;
}

function parsePrInfo(raw: string, number: number): PrInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`GitHub CLI returned invalid JSON for PR #${number}.`, { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("baseRefName" in parsed) ||
    !("baseRefOid" in parsed) ||
    !("baseRepository" in parsed) ||
    !("headRefName" in parsed) ||
    !("headRefOid" in parsed) ||
    !("title" in parsed) ||
    typeof parsed.baseRefName !== "string" ||
    typeof parsed.baseRefOid !== "string" ||
    !/^[a-f0-9]{40}$/i.test(parsed.baseRefOid) ||
    typeof parsed.baseRepository !== "object" ||
    parsed.baseRepository === null ||
    !("nameWithOwner" in parsed.baseRepository) ||
    typeof parsed.baseRepository.nameWithOwner !== "string" ||
    !/^[^/\s]+\/[^/\s]+$/.test(parsed.baseRepository.nameWithOwner) ||
    typeof parsed.headRefName !== "string" ||
    typeof parsed.headRefOid !== "string" ||
    !/^[a-f0-9]{40}$/i.test(parsed.headRefOid) ||
    typeof parsed.title !== "string"
  ) {
    throw new Error(`GitHub CLI returned incomplete metadata for PR #${number}.`);
  }
  return {
    baseRefName: parsed.baseRefName,
    baseRefOid: parsed.baseRefOid.toLowerCase(),
    baseRepository: parsed.baseRepository.nameWithOwner,
    headRefName: parsed.headRefName,
    headRefOid: parsed.headRefOid.toLowerCase(),
    title: parsed.title,
  };
}

async function freezePrBase(git: GitClient, info: PrInfo): Promise<string> {
  let resolved = await git.run(["rev-parse", "--verify", `${info.baseRefOid}^{commit}`], {
    allowFailure: true,
  });
  if (resolved.code !== 0) {
    const fetched = await git.run(
      [
        "fetch",
        "--no-tags",
        `https://github.com/${info.baseRepository}.git`,
        `refs/heads/${info.baseRefName}`,
      ],
      { allowFailure: true },
    );
    if (fetched.code !== 0) {
      const detail = shortError(fetched);
      throw new Error(
        `Could not fetch current PR base ${info.baseRefName} at ${info.baseRefOid.slice(0, 12)}${detail ? `: ${detail}` : "."}`,
      );
    }
    resolved = await git.run(["rev-parse", "--verify", `${info.baseRefOid}^{commit}`], {
      allowFailure: true,
    });
  }
  if (resolved.code !== 0 || resolved.stdout.trim().toLowerCase() !== info.baseRefOid) {
    throw new Error(
      `Could not resolve current PR base ${info.baseRefName} at ${info.baseRefOid.slice(0, 12)}.`,
    );
  }
  return info.baseRefOid;
}

export async function hasIgnoredWorktreeEntries(git: GitClient): Promise<boolean> {
  const found = new Error("Ignored worktree entry found.");
  try {
    await git.stream(
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "--no-empty-directory",
        "-z",
      ],
      (chunk) => {
        if (chunk.length > 0) throw found;
      },
    );
    return false;
  } catch (error) {
    if (error === found) return true;
    throw error;
  }
}

async function hasWorktreeChanges(git: GitClient): Promise<boolean> {
  if ((await git.status()).trim().length > 0) return true;
  return hasIgnoredWorktreeEntries(git);
}

async function assertNoStagedChanges(git: GitClient): Promise<void> {
  const result = await git.run(["diff", "--cached", "--quiet", "--exit-code", "--"], {
    allowFailure: true,
  });
  if (result.code === 1) throw new Error(STAGED_CHANGES_MESSAGE);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`Could not inspect staged changes${detail ? `: ${detail}` : "."}`);
  }
}

async function restoreAfterFailedPrCheckout(
  execute: ExecGit,
  repositoryRoot: string,
  originalHead: string,
  originalBranch: string | undefined,
): Promise<void> {
  const args = originalBranch
    ? ["switch", "--", originalBranch]
    : ["switch", "--detach", originalHead];
  // Cleanup must remain possible after the caller's operation signal is cancelled.
  await executeChecked(execute, "git", args, { cwd: repositoryRoot });

  const restored = new GitClient(execute, repositoryRoot);
  const [head, branch] = await Promise.all([restored.head(), restored.branch()]);
  if (head !== originalHead || branch !== originalBranch) {
    throw new Error(
      `restored worktree does not match its original state (expected ${originalBranch ?? "detached"} at ${originalHead.slice(0, 12)})`,
    );
  }
}

async function resolvePr(
  request: Extract<ReviewTargetRequest, { type: "pullRequest" }>,
  options: ResolveTargetOptions,
  initialGit: GitClient,
  repositoryRoot: string,
): Promise<ReviewTargetSnapshot> {
  const version = await executeChecked(options.execute, "gh", ["--version"], {
    cwd: repositoryRoot,
    signal: options.signal,
    allowFailure: true,
  });
  if (version.code !== 0)
    throw new Error(`Pull-request review requires GitHub CLI. ${GH_SETUP_INSTRUCTIONS}`);
  const auth = await executeChecked(options.execute, "gh", ["auth", "status"], {
    cwd: repositoryRoot,
    signal: options.signal,
    allowFailure: true,
  });
  if (auth.code !== 0) {
    throw new Error(
      "GitHub CLI is installed but not authenticated. Run `gh auth login` and `gh auth status`.",
    );
  }
  if (await hasWorktreeChanges(initialGit)) throw new Error(PR_DIRTY_MESSAGE);

  const { number, ghReference } = parsePrReference(request.reference);
  const currentRepositoryResult = await executeChecked(
    options.execute,
    "gh",
    ["repo", "view", "--json", "nameWithOwner"],
    { cwd: repositoryRoot, signal: options.signal, allowFailure: true },
  );
  const currentRepository =
    currentRepositoryResult.code === 0
      ? parseRepositoryNameWithOwner(currentRepositoryResult.stdout)
      : undefined;
  options.notify?.(`Fetching PR #${number} metadata…`, "info");
  const infoResult = await executeChecked(
    options.execute,
    "gh",
    [
      "pr",
      "view",
      ghReference,
      "--json",
      "baseRefName,baseRefOid,baseRepository,headRefName,headRefOid,title",
    ],
    { cwd: repositoryRoot, signal: options.signal, allowFailure: true },
  );
  if (infoResult.code !== 0) {
    throw new Error(
      `Could not fetch PR #${number}${shortError(infoResult) ? `: ${shortError(infoResult)}` : "."}`,
    );
  }
  const info = parsePrInfo(infoResult.stdout, number);
  // GitHub's immutable OID is authoritative. A local tracking branch may be arbitrarily stale.
  const frozenBaseHead = await freezePrBase(initialGit, info);
  if (await hasWorktreeChanges(initialGit)) throw new Error(PR_DIRTY_MESSAGE);

  const preCheckoutHead = await initialGit.head();
  const preCheckoutBranch = await initialGit.branch();
  options.notify?.(`Checking out PR #${number}…`, "info");
  try {
    const checkout = await executeChecked(options.execute, "gh", ["pr", "checkout", ghReference], {
      cwd: repositoryRoot,
      signal: options.signal,
      allowFailure: true,
    });
    if (checkout.code !== 0) {
      throw new Error(
        `Failed to check out PR #${number}: ${shortError(checkout) || "unknown error"}`,
      );
    }

    const git = new GitClient(options.execute, repositoryRoot, options.signal);
    const originalHead = await git.head();
    const originalBranch = await git.branch();
    if (!originalBranch) throw new Error("The checked-out pull request has no active branch.");
    if (originalHead.toLowerCase() !== info.headRefOid) {
      throw new Error(
        `Checked-out PR #${number} branch ${info.headRefName} is at ${originalHead.slice(0, 12)}, but GitHub reports ${info.headRefOid.slice(0, 12)}.`,
      );
    }

    const baseSha = await resolveMergeBase(git, originalHead, frozenBaseHead, info.baseRefName);
    return {
      type: "pullRequest",
      repositoryRoot,
      originalHead,
      originalBranch,
      baseSha,
      pullRequest: {
        number,
        title: info.title,
        baseBranch: info.baseRefName,
        isCurrentRepository: currentRepository?.toLowerCase() === info.baseRepository.toLowerCase(),
      },
    };
  } catch (error) {
    try {
      options.notify?.("PR target resolution failed; restoring the original worktree…", "warning");
      await restoreAfterFailedPrCheckout(
        options.execute,
        repositoryRoot,
        preCheckoutHead,
        preCheckoutBranch,
      );
    } catch (restoreError) {
      const primary = error instanceof Error ? error.message : String(error);
      const restoration =
        restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`${primary} Failed to restore the original worktree: ${restoration}`, {
        cause: new AggregateError([error, restoreError]),
      });
    }
    throw error;
  }
}

async function validateFolderPaths(
  repositoryRoot: string,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const normalized = [
    ...new Set(paths.map((path) => normalizeRepositoryPath(repositoryRoot, path))),
  ];
  if (normalized.length === 0) throw new Error("Folder review requires at least one path.");
  const metadataCache: GitMetadataPathCache = new Map();
  const [realRoot, rootMetadataPaths] = await Promise.all([
    realpath(repositoryRoot),
    repositoryRootGitMetadataRealPaths(repositoryRoot),
  ]);
  const canonical: string[] = [];
  for (const path of normalized) {
    if (repositoryPathHasGitMetadataComponent(path)) {
      throw new Error(`Review path may not select Git metadata: ${path}`);
    }
    const absolute = resolve(repositoryRoot, path);
    const pathStat = await lstat(absolute).catch(() => undefined);
    if (!pathStat) throw new Error(`Review path does not exist: ${path}`);
    const resolved = await realpath(absolute);
    const metadataPaths = await nearbyGitMetadataRealPaths(
      repositoryRoot,
      resolved,
      signal,
      metadataCache,
    );
    const fromRoot = relative(realRoot, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Review path resolves outside the repository: ${path}`);
    }
    if (
      resolvedPathHasGitMetadataComponent(realRoot, resolved) ||
      metadataPaths.some(
        (metadataPath) =>
          resolvedPathIsWithin(metadataPath, resolved) ||
          (resolvedPathIsWithin(resolved, metadataPath) &&
            !(
              resolved === realRoot &&
              rootMetadataPaths.some((rootMetadataPath) =>
                resolvedPathIsWithin(rootMetadataPath, metadataPath),
              )
            )),
      )
    ) {
      throw new Error(`Review path may not select Git metadata: ${path}`);
    }
    canonical.push(fromRoot === "" ? "." : fromRoot.split(sep).join("/"));
  }
  return [...new Set(canonical)].sort();
}

export async function resolveTarget(
  request: ReviewTargetRequest,
  options: ResolveTargetOptions,
): Promise<ReviewTargetSnapshot> {
  const initialGit = new GitClient(options.execute, options.cwd, options.signal);
  const repositoryRoot = await initialGit.repositoryRoot().catch((error) => {
    throw new Error("Review loop must run inside a Git repository.", { cause: error });
  });
  const git = new GitClient(options.execute, repositoryRoot, options.signal);

  if (request.type === "pullRequest") {
    return resolvePr(request, options, git, repositoryRoot);
  }

  const originalHead = await git.head();
  const originalBranch = await git.branch();
  if (!originalBranch)
    throw new Error("Review loop requires an active branch (detached HEAD is unsupported).");

  switch (request.type) {
    case "uncommitted":
      await assertNoStagedChanges(git);
      return {
        type: "uncommitted",
        repositoryRoot,
        originalHead,
        originalBranch,
        baseSha: originalHead,
        initialUntrackedPaths: await listUntrackedFiles(git, repositoryRoot),
      };

    case "baseBranch": {
      await assertNoStagedChanges(git);
      const branchSha = await resolveCommit(git, request.branch);
      if (branchSha === originalHead || request.branch === originalBranch) {
        throw new Error("The review base branch must differ from the current branch.");
      }
      const baseSha = await resolveMergeBase(git, originalHead, branchSha, request.branch);
      return {
        type: "baseBranch",
        repositoryRoot,
        originalHead,
        originalBranch,
        baseSha,
        initialUntrackedPaths: await listUntrackedFiles(git, repositoryRoot),
        branch: request.branch,
      };
    }

    case "commit": {
      if ((await git.status()).trim()) throw new Error(COMMIT_DIRTY_MESSAGE);
      const commitSha = await resolveCommit(git, request.sha);
      if (commitSha !== originalHead) {
        throw new Error(
          "Commit review loops initially support only the current HEAD commit; historical commits are not checked out or rewritten.",
        );
      }
      const parent = await git.run(["rev-parse", "--verify", `${commitSha}^`], {
        allowFailure: true,
      });
      if (parent.code !== 0 || !parent.stdout.trim()) {
        throw new Error(
          "The current HEAD commit has no first parent and cannot be repaired in place.",
        );
      }
      const titleResult = await git.run(["show", "-s", "--format=%s", commitSha]);
      return {
        type: "commit",
        repositoryRoot,
        originalHead,
        originalBranch,
        baseSha: parent.stdout.trim(),
        commitSha,
        commitTitle: request.title?.trim() || titleResult.stdout.trim(),
      };
    }

    case "folder":
      return {
        type: "folder",
        repositoryRoot,
        originalHead,
        originalBranch,
        paths: await validateFolderPaths(repositoryRoot, request.paths, options.signal),
      };
  }
}

export async function assertTargetInvariants(
  git: GitClient,
  target: ReviewTargetSnapshot,
): Promise<void> {
  if (target.type !== "folder") await assertNoStagedChanges(git);
  const [head, branch] = await Promise.all([git.head(), git.branch()]);
  if (head !== target.originalHead) {
    throw new Error(
      `HEAD changed during the review loop (${target.originalHead.slice(0, 12)} → ${head.slice(0, 12)}).`,
    );
  }
  if (branch !== target.originalBranch) {
    throw new Error(
      `Active branch changed during the review loop (${target.originalBranch ?? "detached"} → ${branch ?? "detached"}).`,
    );
  }
}

export async function getSmartDefault(
  execute: ExecGit,
  cwd: string,
): Promise<"uncommitted" | "baseBranch" | "commit"> {
  const git = new GitClient(execute, cwd);
  const statusResult = await git.run(["status", "--porcelain", "--untracked-files=all"]);
  if (statusResult.stdout.trim()) return "uncommitted";
  const current = await git.branch();
  const [base, branches] = await Promise.all([defaultBranch(git), listLocalBranches(git)]);
  return current && base && current !== base && branches.some((branch) => branch !== current)
    ? "baseBranch"
    : "commit";
}

export const REVIEW_GUIDELINES_MAX_BYTES = 32 * 1024;

async function lstatOptional(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function hasWorktreePiDirectory(directory: string): Promise<boolean> {
  return (await lstatOptional(join(directory, ".pi")))?.isDirectory() ?? false;
}

/** Locate only an ancestor-owned guideline source; the repository source is target-specific. */
export async function findProjectReviewGuidelinesAncestor(
  repositoryRoot: string,
  projectTrusted: boolean,
): Promise<string | undefined> {
  if (!projectTrusted) return undefined;
  let directory = dirname(resolve(repositoryRoot));
  while (true) {
    if (await hasWorktreePiDirectory(directory)) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

interface GitTreeEntry {
  mode: string;
  type: string;
}

async function gitTreeEntry(
  git: GitClient,
  baseSha: string,
  path: string,
): Promise<GitTreeEntry | undefined> {
  const result = await git.run(["--literal-pathspecs", "ls-tree", "-z", baseSha, "--", path]);
  if (!result.stdout) return undefined;
  const match = result.stdout.match(/^(\d{6}) ([^ ]+) [0-9a-f]+\t/);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Could not inspect ${path} in the frozen review baseline.`);
  }
  return { mode: match[1], type: match[2] };
}

async function loadBaselineReviewGuidelines(
  git: GitClient,
  baseSha: string,
): Promise<string | undefined> {
  const path = "REVIEW_GUIDELINES.md";
  const entry = await gitTreeEntry(git, baseSha, path);
  if (!entry) return undefined;
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new Error(`${path} in the frozen review baseline is not a regular file.`);
  }
  const object = `${baseSha}:${path}`;
  const sizeResult = await git.run(["cat-file", "-s", object]);
  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Could not determine the size of ${path} in the frozen review baseline.`);
  }
  if (size > REVIEW_GUIDELINES_MAX_BYTES) {
    throw new Error(`${path} exceeds its ${REVIEW_GUIDELINES_MAX_BYTES}-byte safety limit.`);
  }
  const content = (await git.run(["show", object])).stdout;
  if (Buffer.byteLength(content) > REVIEW_GUIDELINES_MAX_BYTES) {
    throw new Error(`${path} exceeds its ${REVIEW_GUIDELINES_MAX_BYTES}-byte safety limit.`);
  }
  return content.trim() || undefined;
}

export async function loadWorktreeReviewGuidelines(
  directory: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) throw abortError("Review guideline read aborted.");
  const guidelinePath = join(directory, "REVIEW_GUIDELINES.md");
  const itemStat = await lstatOptional(guidelinePath);
  if (!itemStat) return undefined;
  if (itemStat.isSymbolicLink() || !itemStat.isFile()) {
    throw new Error(`${guidelinePath} is not a regular file.`);
  }
  const [directoryReal, guidelineReal] = await Promise.all([
    realpath(directory),
    realpath(guidelinePath),
  ]);
  if (!resolvedPathIsWithin(directoryReal, guidelineReal)) {
    throw new Error(`${guidelinePath} resolves outside its trusted project directory.`);
  }

  const handle = await open(guidelinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new Error(`${guidelinePath} is not a regular file.`);
    if (openedStat.size > REVIEW_GUIDELINES_MAX_BYTES) {
      throw new Error(
        `${guidelinePath} exceeds its ${REVIEW_GUIDELINES_MAX_BYTES}-byte safety limit.`,
      );
    }
    const buffer = Buffer.alloc(REVIEW_GUIDELINES_MAX_BYTES + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      if (signal?.aborted) throw abortError("Review guideline read aborted.");
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes > REVIEW_GUIDELINES_MAX_BYTES) {
      throw new Error(
        `${guidelinePath} exceeds its ${REVIEW_GUIDELINES_MAX_BYTES}-byte safety limit.`,
      );
    }
    return buffer.subarray(0, totalBytes).toString("utf8").trim() || undefined;
  } finally {
    await handle.close();
  }
}

export interface LoadProjectReviewGuidelinesOptions {
  target: ReviewTargetSnapshot;
  execute: ExecGit;
  projectTrusted: boolean;
  ancestorDirectory?: string;
  signal?: AbortSignal;
}

/** Load instructions from the frozen baseline, or an explicit trusted worktree for snapshots. */
export async function loadProjectReviewGuidelines(
  options: LoadProjectReviewGuidelinesOptions,
): Promise<string | undefined> {
  if (!options.projectTrusted) return undefined;
  const { target } = options;
  if (target.type === "folder") {
    if (await hasWorktreePiDirectory(target.repositoryRoot)) {
      return loadWorktreeReviewGuidelines(target.repositoryRoot, options.signal);
    }
  } else if (target.type !== "pullRequest" || target.pullRequest?.isCurrentRepository === true) {
    if (!target.baseSha) throw new Error("Diff target is missing its frozen base SHA.");
    const git = new GitClient(options.execute, target.repositoryRoot, options.signal);
    const piEntry = await gitTreeEntry(git, target.baseSha, ".pi");
    if (piEntry?.type === "tree" && piEntry.mode === "040000") {
      return loadBaselineReviewGuidelines(git, target.baseSha);
    }
  }

  return options.ancestorDirectory
    ? loadWorktreeReviewGuidelines(options.ancestorDirectory, options.signal)
    : undefined;
}

export interface ReviewContextFile {
  path: string;
  content: string;
}

export interface LoadTargetContextFilesOptions {
  target: ReviewTargetSnapshot;
  execute: ExecGit;
  outerContextFiles: readonly ReviewContextFile[];
  projectTrusted: boolean;
  signal?: AbortSignal;
}

function pathIsWithinRepository(repositoryRoot: string, path: string): boolean {
  const fromRoot = relative(repositoryRoot, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

async function canonicalContextPath(path: string): Promise<string> {
  const absolute = resolve(path);
  let existing = absolute;
  while (!(await lstatOptional(existing))) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
  return resolve(await realpath(existing), relative(existing, absolute));
}

/**
 * Retain context owned outside the repository, then discover repository context from trusted
 * non-PR targets. This avoids carrying branch-stale files across checkout and follows folder/file
 * scopes that are not ancestors of the outer session cwd.
 */
export async function loadTargetContextFiles(
  options: LoadTargetContextFilesOptions,
): Promise<ReviewContextFile[]> {
  const { target } = options;
  const repositoryRoot = await realpath(target.repositoryRoot);
  const contextFiles: ReviewContextFile[] = [];
  const seenPaths = new Set<string>();
  for (const file of options.outerContextFiles) {
    const path = await canonicalContextPath(file.path);
    if (pathIsWithinRepository(repositoryRoot, path)) continue;
    contextFiles.push(file);
    seenPaths.add(path);
  }
  // Project trust was established before a PR checkout. Never promote instruction files from the
  // attacker-controlled PR worktree into reviewer or fixer system prompts.
  if (!options.projectTrusted || target.type === "pullRequest") return contextFiles;
  const git = new GitClient(options.execute, target.repositoryRoot, options.signal);
  const paths = await getChangedFiles(git, target);
  const targetPaths = paths.length > 0 ? paths : ["."];

  for (const path of targetPaths) {
    if (options.signal?.aborted) throw abortError("Review context discovery aborted.");
    const absolute = resolve(target.repositoryRoot, path);
    const itemStat = await lstatOptional(absolute);
    const directory = itemStat?.isDirectory() ? absolute : dirname(absolute);
    for (const file of loadProjectContextFiles({
      cwd: directory,
      // The SDK loader always checks its agent directory first. Using the repository root keeps
      // discovery repository-local; outer global context was retained above.
      agentDir: target.repositoryRoot,
    })) {
      const resolvedPath = await canonicalContextPath(file.path);
      if (!pathIsWithinRepository(repositoryRoot, resolvedPath) || seenPaths.has(resolvedPath)) {
        continue;
      }
      contextFiles.push(file);
      seenPaths.add(resolvedPath);
    }
  }
  return contextFiles;
}

export function describeTarget(target: ReviewTargetSnapshot): string {
  switch (target.type) {
    case "uncommitted":
      return `uncommitted changes against ${target.originalHead.slice(0, 12)}`;
    case "baseBranch":
      return `changes against ${target.branch} (merge base ${target.baseSha?.slice(0, 12)})`;
    case "commit":
      return `HEAD commit ${target.commitSha?.slice(0, 12)}${target.commitTitle ? ` (${target.commitTitle})` : ""}`;
    case "pullRequest":
      return `PR #${target.pullRequest?.number} (${target.pullRequest?.title ?? "untitled"})`;
    case "folder":
      return `snapshot of ${(target.paths ?? []).join(", ")}`;
  }
}
