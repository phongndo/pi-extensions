import assert from "node:assert/strict";
import test from "node:test";
import type { ReviewLoopResult } from "../models.ts";
import { resultContextContent, sanitizeTerminalText } from "../renderers.ts";

function result(reason: string): ReviewLoopResult {
  return {
    version: 1,
    runId: "run",
    status: "blocked",
    reason,
    passes: [],
    ledger: [],
    excludedFindings: [],
    humanCallouts: ["callout\u001b]52;c;Y2xpcGJvYXJk\u0007"],
    findingsFixed: 0,
    verification: {
      configured: true,
      command: "check\u001b[31m",
      passed: false,
      output: "failure\u001b]0;owned\u0007\nnext\u0008",
    },
    reviewer: {
      reference: { provider: "test", modelId: "reviewer" },
      thinkingLevel: "off",
      displayName: "Reviewer",
    },
    fixer: {
      reference: { provider: "test", modelId: "fixer" },
      thinkingLevel: "off",
      displayName: "Fixer",
    },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    startedAt: "start",
    finishedAt: "finish",
    editsMayRemain: false,
  };
}

test("sanitizes terminal escape and control sequences while preserving lines", () => {
  assert.equal(
    sanitizeTerminalText("one\u001b[31mred\u001b[0m\u001b]52;c;secret\u0007\r\ntwo\u0008"),
    "onered\ntwo",
  );
  assert.equal(sanitizeTerminalText("safe\u001b]0;unterminated"), "safe");
});

test("describes intentionally skipped verification without calling it failed", () => {
  const value = result("Skipped for an untrusted pull-request checkout.");
  value.verification = {
    configured: true,
    command: "pnpm check",
    passed: false,
    skipped: true,
    output: "Skipped for an untrusted pull-request checkout.",
  };

  const content = resultContextContent(value);
  assert.match(content, /Verification skipped: pnpm check/);
  assert.doesNotMatch(content, /Verification failed/);
});

test("sanitizes all dynamic result context fields", () => {
  const content = resultContextContent(result("blocked\u001b]0;title\u0007\u0001"));
  // eslint-disable-next-line no-control-regex -- Assert that raw control bytes were removed.
  assert.equal(/[\u001b\u0001\u0007\u0008]/.test(content), false);
  assert.match(content, /failure/);
  assert.match(content, /next/);
});
