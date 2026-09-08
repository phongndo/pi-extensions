import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPreferenceLock, writePreferenceJson } from "../src/preference-file.ts";

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
    await mkdir(`${path}.lock`);
    const past = new Date(Date.now() - 600_000);
    await utimes(`${path}.lock`, past, past);
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
