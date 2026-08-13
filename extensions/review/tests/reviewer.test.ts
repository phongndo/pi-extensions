import assert from "node:assert/strict";
import test from "node:test";
import { findingVerifierActiveTools } from "../finding-verifier.ts";
import { createReviewerPassCache, reviewerActiveTools } from "../reviewer.ts";

test("reviewers inherit normal inspection tools without review-specific inspection tools", () => {
  const tools = new Set(reviewerActiveTools(["fffind", "ffgrep", "custom", "edit", "write"]));
  assert.ok(tools.has("bash"));
  assert.ok(tools.has("fffind"));
  assert.ok(tools.has("ffgrep"));
  assert.ok(tools.has("custom"));
  assert.ok(tools.has("submit_review"));
  assert.equal(tools.size, 9);
  assert.equal(tools.has("edit"), false);
  assert.equal(tools.has("write"), false);
});

test("finding verifiers inherit inspection tools but cannot edit or write", () => {
  const tools = new Set(
    findingVerifierActiveTools(["fffind", "ffgrep", "custom", "edit", "write"]),
  );
  assert.ok(tools.has("bash"));
  assert.ok(tools.has("fffind"));
  assert.ok(tools.has("submit_finding_verification"));
  assert.equal(tools.has("edit"), false);
  assert.equal(tools.has("write"), false);
});

test("reviewer pass cache shares successes and evicts rejected operations", async () => {
  const cache = createReviewerPassCache();
  let attempts = 0;
  const failed = cache.get("changedFiles", async () => {
    attempts += 1;
    throw new Error("transient changed-file failure");
  });
  assert.equal(
    cache.get("changedFiles", async () => ["unexpected"]),
    failed,
  );
  await assert.rejects(failed, /transient changed-file failure/);

  assert.deepEqual(
    await cache.get("changedFiles", async () => {
      attempts += 1;
      return ["src/ready.ts"];
    }),
    ["src/ready.ts"],
  );
  assert.equal(attempts, 2);
  assert.deepEqual(await cache.get("changedFiles", async () => ["unexpected"]), ["src/ready.ts"]);
});
