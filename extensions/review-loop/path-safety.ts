import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { abortError, normalizeRepositoryPath } from "./git.ts";

export function repositoryPathHasGitMetadataComponent(path: string): boolean {
  return path.split(/[\\/]/).some((component) => component.toLowerCase() === ".git");
}

export function resolvedPathIsWithin(parent: string, candidate: string): boolean {
  const fromParent = relative(parent, candidate);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  );
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export async function lstatIfExists(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

export const GIT_CONTROL_FILE_MAX_BYTES = 8 * 1024;

async function readGitControlFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Git metadata control path is not a file: ${path}`);
    if (info.size > GIT_CONTROL_FILE_MAX_BYTES) {
      throw new Error(`Git metadata control file exceeds its byte safety limit: ${path}`);
    }
    const content = Buffer.alloc(GIT_CONTROL_FILE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < content.length) {
      const read = await file.read(content, bytesRead, content.length - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > GIT_CONTROL_FILE_MAX_BYTES) {
      throw new Error(`Git metadata control file exceeds its byte safety limit: ${path}`);
    }
    return content.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}

async function metadataPathsForDotGit(dotGit: string): Promise<string[]> {
  const dotGitReal = await realpath(dotGit);
  const paths = [dotGit, dotGitReal];
  if (!(await stat(dotGit)).isFile()) return paths;

  const gitDirLine = (await readGitControlFile(dotGit)).trim();
  const match = gitDirLine.match(/^gitdir:\s*(.+)$/i);
  if (!match?.[1]?.trim()) {
    throw new Error(`Malformed Git metadata file: ${dotGit}`);
  }
  const gitDirValue = match[1].trim();
  const gitDir = isAbsolute(gitDirValue) ? gitDirValue : resolve(dirname(dotGit), gitDirValue);
  const gitDirReal = await realpath(gitDir);
  paths.push(gitDirReal);

  const commonDirFile = resolve(gitDirReal, "commondir");
  if (await lstatIfExists(commonDirFile)) {
    const commonDirValue = (await readGitControlFile(commonDirFile)).trim();
    if (!commonDirValue) {
      throw new Error(`Malformed Git commondir file: ${commonDirFile}`);
    }
    const commonDir = isAbsolute(commonDirValue)
      ? commonDirValue
      : resolve(gitDirReal, commonDirValue);
    paths.push(await realpath(commonDir));
  }
  return paths;
}

export async function repositoryRootGitMetadataRealPaths(
  repositoryRoot: string,
): Promise<string[]> {
  const dotGit = resolve(await realpath(repositoryRoot), ".git");
  if (!(await lstatIfExists(dotGit))) return [];
  return [...new Set(await metadataPathsForDotGit(dotGit))];
}

export type GitMetadataPathCache = Map<string, readonly string[]>;

/**
 * Discover every bounded Git metadata entry under the repository. A nested worktree may alias a
 * metadata directory outside its own ancestors, so safety decisions must share this global map.
 */
export async function nearbyGitMetadataRealPaths(
  repositoryRoot: string,
  targetReal: string,
  signal?: AbortSignal,
  pathCache?: GitMetadataPathCache,
): Promise<string[]> {
  assertMetadataScanActive(signal);
  const rootReal = await realpath(repositoryRoot);
  const cached = pathCache?.get(rootReal);
  if (cached) return [...cached];

  // Keep the parameter as part of the public validation API even though the safe map is global.
  void targetReal;
  const paths: string[] = [];
  const checked = new Set<string>();
  let directoriesSeen = 0;
  const countDirectory = (): void => {
    directoriesSeen += 1;
    if (directoriesSeen > GIT_METADATA_SCAN_MAX_ENTRIES) {
      throw metadataScanLimitError("entry");
    }
  };
  const inspectDotGit = async (dotGit: string): Promise<void> => {
    assertMetadataScanActive(signal);
    if (checked.has(dotGit)) return;
    checked.add(dotGit);
    const entry = await lstatIfExists(dotGit);
    if (!entry) return;
    // A present entry must be fully parsed. An unreadable alias, gitdir, or commondir makes the
    // relevance of the requested path unknowable, so authorization fails closed.
    paths.push(...(await metadataPathsForDotGit(dotGit)));
  };

  // Include ancestor metadata for repositories rooted below a linked checkout.
  let ancestor = rootReal;
  for (let depth = 0; ; depth += 1) {
    assertMetadataScanActive(signal);
    if (depth > GIT_METADATA_SCAN_MAX_DEPTH) throw metadataScanLimitError("depth");
    countDirectory();
    await inspectDotGit(resolve(ancestor, ".git"));
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const directories: Array<{ path: string; depth: number }> = [{ path: rootReal, depth: 0 }];
  for (let index = 0; index < directories.length; index += 1) {
    assertMetadataScanActive(signal);
    const current = directories[index]!;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch (error) {
      throw new Error(`Cannot complete Git metadata safety scan for ${current.path}.`, {
        cause: error,
      });
    }
    for await (const entry of directory) {
      assertMetadataScanActive(signal);
      const absolute = resolve(current.path, entry.name);
      if (entry.name.toLowerCase() === ".git") {
        await inspectDotGit(absolute);
      } else if (entry.isDirectory()) {
        countDirectory();
        if (current.depth >= GIT_METADATA_SCAN_MAX_DEPTH) {
          throw metadataScanLimitError("depth");
        }
        directories.push({ path: absolute, depth: current.depth + 1 });
      }
    }
  }

  const result = [...new Set(paths)];
  pathCache?.set(rootReal, result);
  return [...result];
}

export function resolvedPathHasGitMetadataComponent(
  rootReal: string,
  candidateReal: string,
): boolean {
  return repositoryPathHasGitMetadataComponent(relative(rootReal, candidateReal));
}

// The scan charges only directories, not ordinary files. The high bound still prevents
// pathological directory fan-out while accommodating dependency and generated trees.
export const GIT_METADATA_SCAN_MAX_ENTRIES = 200_000;
export const GIT_METADATA_SCAN_MAX_DEPTH = 128;

export interface GitMetadataScanOptions {
  signal?: AbortSignal;
  maxEntries?: number;
  maxDepth?: number;
}

function assertMetadataScanActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError("Git metadata scan aborted.");
}

function metadataScanLimitError(kind: "entry" | "depth"): Error {
  return new Error(`Git metadata scan exceeds its ${kind} safety limit.`);
}

export async function directoryContainsGitMetadata(
  path: string,
  ignoredDotGit?: string,
  options: GitMetadataScanOptions = {},
): Promise<boolean> {
  assertMetadataScanActive(options.signal);
  if (!(await stat(path)).isDirectory()) return false;
  const maxEntries = options.maxEntries ?? GIT_METADATA_SCAN_MAX_ENTRIES;
  const maxDepth = options.maxDepth ?? GIT_METADATA_SCAN_MAX_DEPTH;
  const directories: { path: string; depth: number }[] = [{ path, depth: 0 }];
  let entriesSeen = 0;

  while (directories.length > 0) {
    assertMetadataScanActive(options.signal);
    const current = directories.pop()!;
    const directory = await opendir(current.path);
    for await (const entry of directory) {
      assertMetadataScanActive(options.signal);
      const absolute = resolve(current.path, entry.name);
      if (entry.name.toLowerCase() === ".git") {
        if (absolute !== ignoredDotGit) return true;
        continue;
      }
      if (!entry.isDirectory()) continue;
      entriesSeen += 1;
      if (entriesSeen > maxEntries) throw metadataScanLimitError("entry");
      if (current.depth >= maxDepth) throw metadataScanLimitError("depth");
      directories.push({ path: absolute, depth: current.depth + 1 });
    }
  }
  return false;
}

/** Validate an existing inspection target and return a path that remains relative for SDK tools. */
export async function repositoryInspectionPath(
  repositoryRoot: string,
  inputPath: string,
  recursive = false,
  signal?: AbortSignal,
  metadataCache: GitMetadataPathCache = new Map(),
  requiredType: "any" | "regularFile" | "regularFileOrDirectory" | "directory" = "any",
): Promise<string> {
  const normalized = normalizeRepositoryPath(repositoryRoot, inputPath);
  if (repositoryPathHasGitMetadataComponent(normalized)) {
    throw new Error(`Inspection tools may not read Git metadata: ${normalized}`);
  }

  const [rootReal, targetReal] = await Promise.all([
    realpath(repositoryRoot),
    realpath(resolve(repositoryRoot, normalized)),
  ]);
  const metadataPaths = await nearbyGitMetadataRealPaths(
    repositoryRoot,
    targetReal,
    signal,
    metadataCache,
  );
  if (!resolvedPathIsWithin(rootReal, targetReal)) {
    throw new Error(`Inspection path resolves outside the repository: ${normalized}`);
  }
  if (resolvedPathHasGitMetadataComponent(rootReal, targetReal)) {
    throw new Error(`Inspection tools may not read Git metadata: ${normalized}`);
  }
  if (
    metadataPaths.some(
      (metadataPath) =>
        resolvedPathIsWithin(metadataPath, targetReal) ||
        (recursive && resolvedPathIsWithin(targetReal, metadataPath)),
    )
  ) {
    throw new Error(`Inspection tools may not read Git metadata: ${normalized}`);
  }
  if (requiredType !== "any") {
    const targetStat = await stat(targetReal);
    const valid =
      requiredType === "regularFile"
        ? targetStat.isFile()
        : requiredType === "directory"
          ? targetStat.isDirectory()
          : targetStat.isFile() || targetStat.isDirectory();
    if (!valid) {
      throw new Error(
        requiredType === "regularFile"
          ? `Inspection read path must be a regular file: ${normalized}`
          : requiredType === "directory"
            ? `Inspection path must be a directory: ${normalized}`
            : `Inspection search path must be a regular file or directory: ${normalized}`,
      );
    }
  }
  // Prefix with ./ so SDK path expansion cannot reinterpret a repository entry
  // beginning with ~, @, or a URL-like prefix as an external path.
  return normalized === "." ? "." : `./${normalized}`;
}
