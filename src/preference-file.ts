import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

/** Serialize cooperating writers across processes, including before first creation.
 * Callers must use the supplied canonical path for both reads and writes.
 * External editors do not participate. Keep transactions short: leases cannot
 * fence a process suspended beyond the stale interval.
 */
export async function withPreferenceLock<T>(
  path: string,
  mutate: (path: string, assertOwned: () => void) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(path)), basename(path));
  return withFileMutationQueue(canonical, async () => {
    let compromised: Error | undefined;
    const release = await lockfile.lock(canonical, {
      realpath: false,
      stale: 300_000,
      update: 10_000,
      retries: { retries: 100, factor: 1, minTimeout: 50, maxTimeout: 50 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const assertOwned = () => {
      if (compromised) throw compromised;
    };
    try {
      const result = await mutate(canonical, assertOwned);
      assertOwned();
      return result;
    } finally {
      // proper-lockfile already removes compromised locks from its registry.
      if (!compromised) await release();
    }
  });
}

/** Private, exclusively created temporary file; readers see old or complete JSON.
 * Atomic visibility, not power-loss durability. The caller owns serialization.
 */
export async function writePreferenceJson(
  path: string,
  value: unknown,
  assertOwned: () => void = () => {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.chmod(0o600);
    await file.close();
    assertOwned();
    await rename(temporary, path);
  } finally {
    try {
      await file.close();
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
