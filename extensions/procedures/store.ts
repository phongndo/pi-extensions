import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { AuthoredProcedure, ProcedureDefinition, ProcedureRun } from "./models.ts";
import { READ_ONLY_TOOLS } from "./models.ts";
import {
  normalizeProcedureName,
  validateProcedureSource,
  validateProcedureTools,
} from "./security.ts";

async function atomicWrite(path: string, content: string): Promise<void> {
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProcedureRunSnapshot(value: unknown): value is ProcedureRun {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.title !== "string") return false;
  if (typeof value.status !== "string") return false;
  if (typeof value.phase !== "string") return false;
  if (typeof value.createdAt !== "string" || value.createdAt.length === 0) return false;
  if (typeof value.updatedAt !== "string") return false;
  if (typeof value.model !== "string") return false;
  if (!Array.isArray(value.tasks)) return false;
  if (!Array.isArray(value.events)) return false;
  if (!Array.isArray(value.artifacts)) return false;
  if (!isRecord(value.usage)) return false;
  return true;
}

export class ProcedureDefinitionStore {
  readonly directory: string;

  constructor(cwd: string) {
    this.directory = join(cwd, CONFIG_DIR_NAME, "procedures");
  }

  async uniqueName(requested: string): Promise<string> {
    const base = normalizeProcedureName(requested);
    const names = new Set((await this.list()).map((entry) => entry.name));
    if (!names.has(base)) return base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const candidate = `${base.slice(0, Math.max(1, 63 - String(suffix).length))}-${suffix}`;
      if (!names.has(candidate)) return candidate;
    }
    throw new Error(`Could not allocate a unique name for ${base}.`);
  }

  async save(authored: AuthoredProcedure, goal: string): Promise<ProcedureDefinition> {
    validateProcedureSource(authored.source);
    const name = await this.uniqueName(authored.name);
    const requestedTools = validateProcedureTools(authored.requiredTools);
    const allowedTools = validateProcedureTools([...READ_ONLY_TOOLS, ...requestedTools]);
    const sourceFile = `${name}.proc.js`;
    const definition: ProcedureDefinition = {
      version: 1,
      name,
      title: authored.title.trim().slice(0, 160) || name,
      description: authored.description.trim().slice(0, 1_000),
      goal: goal.trim().slice(0, 16_000),
      sourceFile,
      allowedTools,
      createdAt: new Date().toISOString(),
    };
    const sourcePath = join(this.directory, sourceFile);
    const manifestPath = join(this.directory, `${name}.json`);
    await atomicWrite(sourcePath, `${authored.source.trim()}\n`);
    try {
      await atomicWrite(manifestPath, `${JSON.stringify(definition, null, 2)}\n`);
    } catch (error) {
      throw new Error(`Procedure source was written to ${sourcePath}, but its manifest failed.`, {
        cause: error,
      });
    }
    return definition;
  }

  async list(): Promise<ProcedureDefinition[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const definitions: ProcedureDefinition[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        definitions.push(await this.load(entry.name.slice(0, -5)));
      } catch {
        // A corrupt manifest is skipped here and reported when explicitly loaded.
      }
    }
    return definitions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async load(name: string): Promise<ProcedureDefinition> {
    const normalized = normalizeProcedureName(name.replace(/\.json$/, ""));
    const path = join(this.directory, `${normalized}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ProcedureDefinition>;
    if (
      raw.version !== 1 ||
      raw.name !== normalized ||
      typeof raw.title !== "string" ||
      typeof raw.description !== "string" ||
      typeof raw.goal !== "string" ||
      typeof raw.sourceFile !== "string" ||
      basename(raw.sourceFile) !== raw.sourceFile ||
      !Array.isArray(raw.allowedTools) ||
      typeof raw.createdAt !== "string"
    ) {
      throw new Error(`Invalid procedure manifest: ${path}`);
    }
    return {
      ...raw,
      allowedTools: validateProcedureTools(raw.allowedTools),
    } as ProcedureDefinition;
  }

  async source(definition: ProcedureDefinition): Promise<{ source: string; path: string }> {
    const path = join(this.directory, definition.sourceFile);
    const source = await readFile(path, "utf8");
    validateProcedureSource(source);
    return { source, path };
  }
}

export class ProcedureRunStore {
  readonly directory: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(cwd: string, agentDir = getAgentDir()) {
    const project = createHash("sha256").update(cwd).digest("hex").slice(0, 20);
    this.directory = join(agentDir, "procedure-runs", project);
  }

  async writeSource(source: string): Promise<string> {
    validateProcedureSource(source);
    const path = join(this.directory, "sources", `${randomUUID()}.proc.js`);
    await atomicWrite(path, `${source.trim()}\n`);
    return path;
  }

  async readSource(path: string): Promise<string> {
    const sourceRoot = resolve(this.directory, "sources");
    const candidate = resolve(path);
    const fromRoot = relative(sourceRoot, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error("Procedure run source is outside the private run store.");
    }
    const source = await readFile(candidate, "utf8");
    validateProcedureSource(source);
    return source;
  }

  save(run: ProcedureRun): Promise<void> {
    const snapshot = structuredClone(run);
    const previous = this.writes.get(run.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        atomicWrite(join(this.directory, `${run.id}.json`), `${JSON.stringify(snapshot)}\n`),
      );
    this.writes.set(run.id, next);
    void next.then(
      () => {
        if (this.writes.get(run.id) === next) this.writes.delete(run.id);
      },
      () => {
        if (this.writes.get(run.id) === next) this.writes.delete(run.id);
      },
    );
    return next;
  }

  async load(): Promise<ProcedureRun[]> {
    let entries;
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: ProcedureRun[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(
          await readFile(join(this.directory, entry.name), "utf8"),
        ) as ProcedureRun;
        if (isProcedureRunSnapshot(run)) runs.push(run);
      } catch {
        // Keep monitoring available even if one historical snapshot is corrupt.
      }
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 100);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.writes.values());
  }
}
