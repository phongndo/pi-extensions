import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  preferenceLockPath,
  withPreferenceLock,
  writePreferenceJson,
} from "../src/preference-file.ts";

async function fixture(run: (path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-preference-"));
  try {
    await run(join(root, "state.json"), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("preference lease recovers a stale empty lock", () =>
  fixture(async (path) => {
    await mkdir(preferenceLockPath(path));
    const past = new Date(Date.now() - 600_000);
    await utimes(preferenceLockPath(path), past, past);
    await withPreferenceLock(path, (path, owned) => writePreferenceJson(path, { ok: true }, owned));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ok: true });
  }));

test("failed transactions release the lock and failed ownership checks preserve data", () =>
  fixture(async (path, root) => {
    await writePreferenceJson(path, { old: true });
    await assert.rejects(
      withPreferenceLock(path, async () => {
        throw new Error("failed");
      }),
      /failed/,
    );
    await assert.rejects(
      writePreferenceJson(path, { old: false }, () => {
        throw new Error("lost");
      }),
      /lost/,
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { old: true });
    assert.deepEqual(await readdir(root), ["state.json"]);
    await withPreferenceLock(path, async () => {});
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  }));

test("parent aliases share a queue and never overlap active transactions", () =>
  fixture(async (path, root) => {
    await symlink(root, join(root, "alias"), "dir");
    let active = 0;
    await Promise.all(
      [path, join(root, "alias", "state.json")].map((candidate) =>
        withPreferenceLock(candidate, async () => {
          assert.equal(active++, 0);
          await new Promise((resolve) => setTimeout(resolve, 30));
          assert.equal(--active, 0);
        }),
      ),
    );
  }));

test("locking never caches state on the shared fs module (a Proxy inside Pi)", () =>
  fixture(async (path) => {
    // proper-lockfile's default fs: the instance it would cache on without its own fs.
    const require = createRequire(import.meta.url);
    const shared: object = createRequire(require.resolve("proper-lockfile"))("graceful-fs");
    await withPreferenceLock(path, async () => {});
    // proper-lockfile caches once per fs object, so any earlier lock would have left it here.
    assert.deepEqual(Object.getOwnPropertySymbols(shared), []);
  }));
