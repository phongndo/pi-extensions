import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { repositoryInspectionPath, type GitMetadataPathCache } from "./path-safety.ts";

/** Repository-contained read/search tools shared by reviewer and fixer child sessions. */
export function createRepositoryInspectionTools(
  repositoryRoot: string,
  metadataCache: GitMetadataPathCache = new Map(),
): ToolDefinition<any, any, any>[] {
  const read = createReadToolDefinition(repositoryRoot);
  const grep = createGrepToolDefinition(repositoryRoot);
  const find = createFindToolDefinition(repositoryRoot);
  const ls = createLsToolDefinition(repositoryRoot);

  const guardedRead: typeof read = {
    ...read,
    description: `${read.description} Paths must be repository-relative regular files; Git metadata is unavailable.`,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await repositoryInspectionPath(
        repositoryRoot,
        params.path,
        false,
        signal,
        metadataCache,
        "regularFile",
      );
      return read.execute(toolCallId, { ...params, path }, signal, onUpdate, context);
    },
  };
  const guardedGrep: typeof grep = {
    ...grep,
    description: `${grep.description} Search paths must be repository-relative regular files or directories and must not recursively contain Git metadata; choose a worktree subdirectory instead of the repository root.`,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await repositoryInspectionPath(
        repositoryRoot,
        params.path || ".",
        true,
        signal,
        metadataCache,
        "regularFileOrDirectory",
      );
      return grep.execute(toolCallId, { ...params, path }, signal, onUpdate, context);
    },
  };
  const guardedFind: typeof find = {
    ...find,
    description: `${find.description} Search paths must be repository-relative directories and must not recursively contain Git metadata; choose a worktree subdirectory instead of the repository root.`,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await repositoryInspectionPath(
        repositoryRoot,
        params.path || ".",
        true,
        signal,
        metadataCache,
        "directory",
      );
      return find.execute(toolCallId, { ...params, path }, signal, onUpdate, context);
    },
  };
  const guardedLs: typeof ls = {
    ...ls,
    description: `${ls.description} Paths must be repository-relative directories; Git metadata is unavailable.`,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const path = await repositoryInspectionPath(
        repositoryRoot,
        params.path || ".",
        false,
        signal,
        metadataCache,
        "directory",
      );
      return ls.execute(toolCallId, { ...params, path }, signal, onUpdate, context);
    },
  };

  return [guardedRead, guardedGrep, guardedFind, guardedLs];
}
