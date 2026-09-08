import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scoreAnswer } from "../evals/score.ts";

test("evaluation requires an explicit output path before auth or result creation", () => {
  const home = mkdtempSync(join(tmpdir(), "context-eval-cli-"));
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../evals/run.ts", import.meta.url)), "--run-subscription"],
      {
        cwd: home,
        env: { HOME: home, PI_CODING_AGENT_DIR: home, PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      "Explicit --output=<new-file> required for disposable results",
    );
    assert.equal(result.stdout, "");
    // SDK imports can initialize platform caches; they are not evaluation outputs.
    assert.equal(existsSync(join(home, "docs")), false);
    assert.equal(existsSync(join(home, "auth.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("evaluation scoring ignores Markdown but preserves exact identifiers and values", () => {
  const patterns = [
    /partial transaction/i,
    /expected\s*[=:]?\s*3/i,
    /retry_boundary\.spec\.ts::preserves_outer_transaction/,
  ];
  assert.deepEqual(
    scoreAnswer(
      patterns,
      "**partial** transaction; **Expected:** 3; `retry_boundary.spec.ts::preserves_outer_transaction`",
    ),
    [true, true, true],
  );
  assert.deepEqual(scoreAnswer(patterns, "whole transaction; Expected: 4; retry_other.spec.ts"), [
    false,
    false,
    false,
  ]);
});
