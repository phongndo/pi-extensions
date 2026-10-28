import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/** Serialize cooperating writers across processes, including before first creation.
 * Callers must use the supplied canonical path for both reads and writes.
 * External editors do not participate. Keep transactions short: leases cannot
 * fence a process suspended beyond the stale interval.
 */
// proper-lockfile caches a non-writable symbol on its fs object; Pi's runtime exposes fs
// as a Proxy that rejects re-reading it, which crashes the process on the second lock.
const lockFs = {
  mkdir: fs.mkdir,
  realpath: fs.realpath,
  rmdir: fs.rmdir,
  rmdirSync: fs.rmdirSync,
  stat: fs.stat,
  utimes: fs.utimes,
};

/** proper-lockfile's directory; distinct from the pre-1.4 custom lock's `.lock`, whose marker
 * files proper-lockfile cannot remove and whose reclaim rules would treat this lock as abandoned.
 */
export const preferenceLockPath = (path: string): string => `${path}.v2.lock`;

export async function withPreferenceLock<T>(
  path: string,
  mutate: (path: string, assertOwned: () => void) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const canonical = join(await realpath(dirname(path)), basename(path));
  return withFileMutationQueue(canonical, async () => {
    let compromised: Error | undefined;
    // Loaded on first write so status-only sessions do not pay for it at startup.
    const { default: lockfile } = await import("proper-lockfile");
    const release = await lockfile.lock(canonical, {
      realpath: false,
      lockfilePath: preferenceLockPath(canonical),
      fs: lockFs,
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
