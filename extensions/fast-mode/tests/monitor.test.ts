import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { jest } from "bun:test";
import { FastStateMonitor } from "../monitor.ts";
import { loadFastMode, saveFastMode, setFastMode } from "../state.ts";
import { eventually } from "./helpers.ts";

test("explicit on/off is locked, idempotent, atomic and private", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-explicit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fast-mode.json");
  assert.deepEqual(await Promise.all([setFastMode(true, path), setFastMode(true, path)]), [
    true,
    true,
  ]);
  const before = await stat(path);
  const content = await readFile(path, "utf8");
  await setFastMode(true, path);
  assert.equal((await stat(path)).mtimeMs, before.mtimeMs, "on twice must not rewrite state");
  assert.equal(await readFile(path, "utf8"), content);
  if (process.platform !== "win32") assert.equal(before.mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all([setFastMode(false, path), setFastMode(false, path)]), [
    false,
    false,
  ]);
  assert.equal(await loadFastMode(path), false);
});

test("two idle sessions converge after multiple external atomic replacements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-watch-"));
  const path = join(root, "fast-mode.json");
  const first = new FastStateMonitor(() => {}, path);
  const second = new FastStateMonitor(() => {}, path);
  t.after(async () => {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([first.refresh(), second.refresh()]);
  first.start(30);
  second.start(30);
  for (const enabled of [true, false, true]) {
    await saveFastMode(enabled, path);
    await eventually(
      () => first.snapshot.enabled === enabled && second.snapshot.enabled === enabled,
    );
  }
  first.close();
  await saveFastMode(false, path);
  await eventually(() => second.snapshot.enabled === false);
  assert.equal(first.snapshot.enabled, true);
});

test("polling recovers a missing parent directory and shows state errors then recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-watch-missing-"));
  const directory = join(root, "later");
  const path = join(directory, "fast-mode.json");
  const monitor = new FastStateMonitor(() => {}, path);
  t.after(async () => {
    monitor.close();
    await rm(root, { recursive: true, force: true });
  });
  monitor.start(20);
  await monitor.refresh();
  assert.equal(monitor.snapshot.enabled, false);
  await mkdir(directory);
  await writeFile(path, "broken");
  await eventually(() => monitor.snapshot.error !== undefined);
  assert.equal(monitor.snapshot.enabled, undefined, "invalid is not off");
  await saveFastMode(true, path);
  await eventually(() => monitor.snapshot.enabled === true && !monitor.snapshot.error);
});

test("late reads cannot overwrite newer state and shutdown prevents late UI writes", async () => {
  const pending: Array<(value: boolean) => void> = [];
  let renders = 0;
  const monitor = new FastStateMonitor(
    () => {
      renders++;
    },
    "/unused",
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const first = monitor.refresh();
  const second = monitor.refresh();
  pending[1]!(false);
  await second;
  pending[0]!(true);
  await first;
  assert.equal(monitor.snapshot.enabled, false);
  assert.equal(renders, 1);
  const last = monitor.refresh();
  monitor.close();
  pending[2]!(true);
  await last;
  assert.equal(monitor.snapshot.enabled, false);
  assert.equal(renders, 1);
});

test("slow polling reads do not overlap or starve snapshot publication", async (t) => {
  jest.useFakeTimers();
  t.after(() => jest.useRealTimers());
  const pending: Array<(value: boolean) => void> = [];
  const monitor = new FastStateMonitor(
    () => {},
    "/not-existing-test-directory/state",
    () => new Promise((resolve) => pending.push(resolve)),
  );
  t.after(() => monitor.close());
  monitor.start(10);
  jest.advanceTimersByTime(30);
  assert.equal(pending.length, 1, "poll ticks must share the outstanding background read");
  pending[0]!(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(monitor.snapshot.enabled, true);
  jest.advanceTimersByTime(10);
  assert.equal(pending.length, 2, "polling resumes after completion");
  pending[1]!(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(monitor.snapshot.enabled, false);
});

test("status reads do not create state or lock directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-read-only-"));
  const path = join(root, "missing", "fast-mode.json");
  const monitor = new FastStateMonitor(() => {}, path);
  t.after(async () => {
    monitor.close();
    await rm(root, { recursive: true, force: true });
  });
  await monitor.refresh();
  await assert.rejects(stat(join(root, "missing")), { code: "ENOENT" });
  monitor.start(10);
  await delay(25);
  await assert.rejects(stat(join(root, "missing")), { code: "ENOENT" });
});
