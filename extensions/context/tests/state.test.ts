import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadEnabled, saveEnabled, verifySavedEntry } from "../state.ts";
import { temporary } from "./helpers.ts";

test("global preference defaults on, writes atomically, and rejects corruption", async (t) => {
  const root = await temporary(t);
  const path = join(root, "context.json");
  assert.equal(await loadEnabled(path), true);
  await saveEnabled(path, false);
  assert.equal(await loadEnabled(path), false);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await Promise.all(Array.from({ length: 20 }, (_, i) => saveEnabled(path, i % 2 === 0)));
  assert.equal(typeof (await loadEnabled(path)), "boolean");
  assert.deepEqual(await readdir(root), ["context.json"]);
  await saveEnabled(path, true);
  const before = await readFile(path, "utf8");
  await saveEnabled(path, true);
  assert.equal(await readFile(path, "utf8"), before);
  for (const text of [
    "{",
    "null",
    '{"enabled":true}',
    '{"version":2,"enabled":true}',
    '{"version":1,"enabled":"false"}',
  ]) {
    await writeFile(path, text);
    await assert.rejects(loadEnabled(path));
  }
});

test("checkpoint verification checks persisted data, rejects memory-only, and bounds disk reads", async (t) => {
  const path = join(await temporary(t), "session.jsonl");
  const data = { version: 1, text: "A\u0000".repeat(6000) };
  await writeFile(
    path,
    JSON.stringify({ id: "old", data: "x".repeat(300_000) }) +
      "\n" +
      JSON.stringify({ id: "checkpoint", data }) +
      "\n",
  );
  await verifySavedEntry(path, "checkpoint", data);
  await assert.rejects(verifySavedEntry(path, "checkpoint", { version: 2 }));
  await assert.rejects(verifySavedEntry(undefined, "checkpoint", data), /persisted session/);
  await assert.rejects(verifySavedEntry(path, "missing", data));
  await writeFile(path, '{"id":"checkpoint",');
  await assert.rejects(verifySavedEntry(path, "checkpoint", data));
});
