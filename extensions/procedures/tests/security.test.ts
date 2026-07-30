import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeProcedureName,
  scopedProjectPath,
  terminalText,
  validateProcedureSource,
  validateProcedureTools,
} from "../security.ts";

test("normalizes and validates procedure metadata", () => {
  assert.equal(normalizeProcedureName("  Audit API & Tests  "), "audit-api-tests");
  assert.deepEqual(validateProcedureTools(["read", "read", "grep"]), ["read", "grep"]);
  assert.throws(() => validateProcedureTools(["network"]), /Unknown procedure tool/);
});

test("removes terminal control sequences from dynamic status text", () => {
  assert.equal(terminalText("safe\u001b[31mred\u0000\nnext"), "safe[31mred\nnext");
});

test("accepts orchestration code and rejects host access", () => {
  validateProcedureSource(
    'const result = await $.agent("scan", "inspect", { tools: ["read"] });\nreturn result.text;',
  );
  assert.throws(() => validateProcedureSource("return process.cwd();"), /process access/);
  assert.throws(() => validateProcedureSource('return require("node:fs");'), /require/);
  assert.throws(() => validateProcedureSource('return import("node:fs");'), /dynamic import/);
});

test("project paths reject traversal and symlink escape", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-procedure-security-"));
  const root = join(parent, "project");
  const outside = join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "ok");
  await symlink(outside, join(root, "escape"));

  assert.equal(await scopedProjectPath(root, "inside.txt"), "./inside.txt");
  await assert.rejects(scopedProjectPath(root, "../outside/file.txt"), /outside/);
  await assert.rejects(scopedProjectPath(root, "escape/file.txt"), /outside/);
  await assert.rejects(scopedProjectPath(root, ".git/config", { mutation: true }), /Git metadata/);
});
