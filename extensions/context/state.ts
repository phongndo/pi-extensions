import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const MODES = ["default", "exp"] as const;
export type ContextMode = (typeof MODES)[number];
export const isMode = (value: unknown): value is ContextMode =>
  MODES.some((mode) => mode === value);

export async function loadMode(path: string): Promise<ContextMode> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "default";
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (value && typeof value === "object" && "version" in value) {
    if (value.version === 3 && "mode" in value && isMode(value.mode)) return value.mode;
    // Read older modes without rewriting user files. Removed memory-only mode falls back to Pi.
    if (value.version === 2 && "mode" in value) {
      if (value.mode === "exp-2") return "exp";
      if (value.mode === "default" || value.mode === "exp-1") return "default";
    }
    if (value.version === 1 && "enabled" in value && typeof value.enabled === "boolean")
      return value.enabled ? "exp" : "default";
  }
  throw new Error(
    "Invalid context preference file; using default Pi compaction without memory tools.",
  );
}

/** Explicit mode writes need no read-modify-write lock. Last atomic rename wins. */
export async function saveMode(path: string, mode: ContextMode): Promise<void> {
  if (!isMode(mode)) throw new Error("Unknown context mode.");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 3, mode }) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Compatibility helpers for old embeddings; enabled now selects the single experiment. */
export const loadEnabled = async (path: string): Promise<boolean> =>
  (await loadMode(path)) === "exp";
export const saveEnabled = (path: string, enabled: boolean): Promise<void> =>
  saveMode(path, enabled ? "exp" : "default");

/** Verify the actual session record, not just an in-memory append that failed to persist. */
export async function verifySavedEntry(
  path: string | undefined,
  id: string,
  data: unknown,
  branch?: readonly SessionEntry[],
  signal?: AbortSignal,
): Promise<void> {
  if (!path)
    throw new Error(
      "Fresh-window resets require a persisted session; normal compaction remains available.",
    );
  const file = await open(path, "r");
  try {
    await file.sync();
    signal?.throwIfAborted();
    if (branch) {
      const digest = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const expected = new Map(branch.map((entry) => [entry.id, digest(entry)]));
      const found = new Set<string>();
      const stream = file.createReadStream({ autoClose: false, ...(signal ? { signal } : {}) });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (!line.trim()) continue;
          const entry = JSON.parse(line) as { id?: string; data?: unknown };
          if (!entry?.id || !expected.has(entry.id)) continue;
          if (found.has(entry.id) || digest(entry) !== expected.get(entry.id))
            throw new Error(
              "Persisted branch differs from the in-memory archive; refusing a fresh reset.",
            );
          found.add(entry.id);
          if (entry.id === id && JSON.stringify(entry.data) !== JSON.stringify(data))
            throw new Error("Persisted checkpoint data changed.");
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!found.has(id) || found.size !== expected.size)
        throw new Error("Some branch evidence is missing from disk; refusing a fresh reset.");
      return;
    }
    const { size } = await file.stat();
    const start = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: { id?: unknown; data?: unknown };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.id === id && JSON.stringify(entry.data) === JSON.stringify(data)) return;
    }
    throw new Error(
      "Checkpoint was not found in the persisted session tail; refusing a fresh reset.",
    );
  } finally {
    await file.close();
  }
}
