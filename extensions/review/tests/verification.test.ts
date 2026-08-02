import assert from "node:assert/strict";
import test from "node:test";
import { runVerificationCommand } from "../orchestrator.ts";

test("treats an absent command as a passing unconfigured gate", async () => {
  assert.deepEqual(await runVerificationCommand(undefined, process.cwd()), {
    configured: false,
    passed: true,
  });
});

test("captures verification success and failure", async () => {
  const success = await runVerificationCommand("printf ok", process.cwd());
  assert.equal(success.passed, true);
  assert.equal(success.output, "ok");

  const failure = await runVerificationCommand("printf nope >&2; exit 7", process.cwd());
  assert.equal(failure.passed, false);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.output, "nope");
});

test("marks verification output when the beginning was truncated", async () => {
  const result = await runVerificationCommand(
    "node -e \"process.stdout.write('x'.repeat(40000))\"",
    process.cwd(),
  );
  assert.equal(result.passed, true);
  assert.match(result.output ?? "", /^\[verification output truncated; showing final 32 KiB\]/);
});

test("aborts a running verification process", async () => {
  const controller = new AbortController();
  const promise = runVerificationCommand("sleep 10", process.cwd(), controller.signal);
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.passed, false);
});

test(
  "keeps Unix process-group escalation after the detached shell exits",
  { skip: process.platform === "win32" },
  async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = runVerificationCommand(
      "trap 'exit 0' TERM; sleep 10",
      process.cwd(),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const result = await promise;

    assert.equal(result.aborted, true);
    assert.ok(Date.now() - started >= 900);
  },
);
