import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadEnabled, saveEnabled, verifyArchive } from "../state.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { assistant, temporary, user } from "./helpers.ts";

test("global preference defaults to Pi, writes atomically, and rejects corruption", async (t) => {
  const root = await temporary(t);
  const path = join(root, "context.json");
  assert.equal(await loadEnabled(path), false);
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

test("archive verification streams large records and rejects missing, changed, aborted and memory-only archives", async (t) => {
  const root = await temporary(t);
  const sm = SessionManager.create(root, join(root, "sessions"));
  user(sm, "A\u0000".repeat(150_000));
  sm.appendMessage(assistant([{ type: "text", text: "Persist" }]));
  const path = sm.getSessionFile()!;
  await verifyArchive(path, sm.getBranch());
  await assert.rejects(verifyArchive(undefined, sm.getBranch()), /persisted session/);
  const signal = AbortSignal.abort();
  await assert.rejects(verifyArchive(path, sm.getBranch(), signal));
  const saved = await readFile(path, "utf8");
  for (const corrupt of ["", saved.replace("Persist", "Changed"), '{"id":"broken",']) {
    await writeFile(path, corrupt);
    await assert.rejects(verifyArchive(path, sm.getBranch()));
  }
});
