import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";

type Factory = (cwd: string) => unknown;

const FACTORIES: Record<string, Factory> = {
  bash: createBashToolDefinition,
  powershell: createPowerShellToolDefinition,
  read: createReadToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  grep: createGrepToolDefinition,
  find: createFindToolDefinition,
  ls: createLsToolDefinition,
};

const cache = new Map<string, ToolRenderers | null>();

/** Pi's own renderers for a built-in tool, or undefined for other tools. */
export function builtinRenderers(tool: string): ToolRenderers | undefined {
  if (!cache.has(tool)) {
    const factory = FACTORIES[tool];
    let renderers: ToolRenderers | null = null;
    try {
      renderers = factory ? (factory(process.cwd()) as ToolRenderers) : null;
    } catch {
      renderers = null;
    }
    cache.set(tool, renderers);
  }
  return cache.get(tool) ?? undefined;
}

/**
 * The same renderer: the same function, or the same source from another copy of Pi's module.
 * Pi builds some renderers per tool (bash's), so identity alone misses them.
 */
export function sameRenderer(a: unknown, b: unknown): boolean {
  return (
    a === b || (typeof a === "function" && typeof b === "function" && a.toString() === b.toString())
  );
}

/**
 * Renderers that draw their own shell (`renderShell: "self"`) own their whole row: leave them be,
 * except Pi's built-in edit renderers, which Tidy replaces.
 */
export function ownsItsRow(inner: ToolRenderers | undefined): boolean {
  if (inner?.renderShell !== "self") return false;
  const edit = builtinRenderers("edit");
  return !(
    sameRenderer(inner.renderCall, edit?.renderCall) &&
    sameRenderer(inner.renderResult, edit?.renderResult)
  );
}

/** A result renderer another extension gave a built-in tool, which Tidy shows instead of its own. */
export function customResult(tool: string, inner: ToolRenderers | undefined): boolean {
  const builtin = builtinRenderers(tool);
  if (!builtin || !inner?.renderResult) return false;
  return !sameRenderer(inner.renderResult, builtin.renderResult);
}
