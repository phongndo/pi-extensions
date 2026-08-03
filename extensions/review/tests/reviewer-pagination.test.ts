import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { GitClient, type ExecGit, type StreamGit } from "../git.ts";
import type { ReviewTargetSnapshot } from "../models.ts";
import {
  createReviewerPassCache,
  formatDiffPage,
  reviewerActiveTools,
  ReviewTargetAccess,
} from "../reviewer.ts";

test("reviewers inherit active tools except edit and write", () => {
  const tools = new Set(reviewerActiveTools(["fffind", "ffgrep", "custom", "edit", "write"]));
  assert.ok(tools.has("bash"));
  assert.ok(tools.has("fffind"));
  assert.ok(tools.has("ffgrep"));
  assert.ok(tools.has("custom"));
  assert.equal(tools.has("edit"), false);
  assert.equal(tools.has("write"), false);
});

test("reviewer pass cache shares successes and evicts rejected operations", async () => {
  const cache = createReviewerPassCache();
  let attempts = 0;
  const failed = cache.get("status", async () => {
    attempts += 1;
    throw new Error("transient status failure");
  });
  assert.equal(
    cache.get("status", async () => "unexpected"),
    failed,
  );
  await assert.rejects(failed, /transient status failure/);

  assert.equal(
    await cache.get("status", async () => {
      attempts += 1;
      return "ready";
    }),
    "ready",
  );
  assert.equal(attempts, 2);
  assert.equal(await cache.get("status", async () => "unexpected"), "ready");
});

test("diff continuation uses the lines that fit within the byte budget", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index}-${"x".repeat(1_000)}`);
  const first = formatDiffPage(lines, 0, 100);
  const match = first.match(/request offset (\d+)/);
  assert.ok(match?.[1]);
  const nextOffset = Number(match[1]);
  assert.ok(nextOffset > 0 && nextOffset < lines.length);
  assert.ok(first.includes(`line-${nextOffset - 1}-`));
  assert.ok(!first.includes(`line-${nextOffset}-`));
  assert.ok(Buffer.byteLength(first) < DEFAULT_MAX_BYTES);

  const second = formatDiffPage(lines, nextOffset, 100);
  assert.ok(second.includes(`line-${nextOffset}-`));
});

test("reuses one diff snapshot across requested pages", async () => {
  let streamCalls = 0;
  const execute: ExecGit = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });
  const stream: StreamGit = async (args, _options, onStdout) => {
    streamCalls += 1;
    if (args.includes("diff")) {
      onStdout(Buffer.from("diff --git a/a.ts b/a.ts\n-old\n+new\n"));
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: "/repository",
    originalHead: "a".repeat(40),
    originalBranch: "main",
    baseSha: "a".repeat(40),
  };
  const access = new ReviewTargetAccess(
    new GitClient(execute, target.repositoryRoot, undefined, stream),
    target,
  );

  await access.execute("diff", 0, 1, 0);
  assert.equal(streamCalls, 2);
  await access.execute("diff", 1, 1, 0);
  assert.equal(streamCalls, 2);
});

test("oversized individual diff lines expose every byte through a continuation cursor", () => {
  const lines = [`START-${"x".repeat(DEFAULT_MAX_BYTES * 2)}-END`, "next"];
  let offset = 0;
  let column = 0;
  let previousColumn = -1;
  let sawStart = false;
  let sawEnd = false;

  for (let pageNumber = 0; pageNumber < 10 && offset === 0; pageNumber += 1) {
    const page = formatDiffPage(lines, offset, 2, column);
    sawStart ||= page.includes("START-");
    sawEnd ||= page.includes("-END");
    assert.ok(Buffer.byteLength(page) < DEFAULT_MAX_BYTES);
    const sameLine = page.match(/request offset 0 column (\d+)/);
    if (sameLine?.[1]) {
      const nextColumn = Number(sameLine[1]);
      assert.ok(nextColumn > previousColumn);
      previousColumn = nextColumn;
      column = nextColumn;
      continue;
    }
    const nextLine = page.match(/request offset (\d+)/);
    offset = nextLine?.[1] ? Number(nextLine[1]) : lines.length;
  }

  assert.equal(sawStart, true);
  assert.equal(sawEnd, true);
  assert.ok(offset > 0);
  assert.ok(formatDiffPage(lines, 1, 1).includes("next"));
});
