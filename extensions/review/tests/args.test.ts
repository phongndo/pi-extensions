import assert from "node:assert/strict";
import test from "node:test";
import {
  argumentCompletions,
  commitSelectionItems,
  parseReviewLoopArgs,
  tokenizeArgs,
} from "../loop-command.ts";

test("tokenizes quotes and escapes", () => {
  assert.deepEqual(tokenizeArgs(`branch main --extra "focus on errors"`), [
    "branch",
    "main",
    "--extra",
    "focus on errors",
  ]);
  assert.deepEqual(tokenizeArgs(`folder 'src/a b' docs`), ["folder", "src/a b", "docs"]);
  assert.deepEqual(tokenizeArgs(String.raw`folder "src\my folder"`), [
    "folder",
    String.raw`src\my folder`,
  ]);
  assert.deepEqual(tokenizeArgs(String.raw`uncommitted --extra "match \d+\s+ values"`), [
    "uncommitted",
    "--extra",
    String.raw`match \d+\s+ values`,
  ]);
  assert.deepEqual(tokenizeArgs(String.raw`folder 'src\single path'`), [
    "folder",
    String.raw`src\single path`,
  ]);
  assert.deepEqual(tokenizeArgs(String.raw`uncommitted --extra "say \"yes\""`), [
    "uncommitted",
    "--extra",
    'say "yes"',
  ]);
  assert.throws(() => tokenizeArgs(`folder "unterminated`), /Unterminated quote/);
});

test("sanitizes repository-controlled commit subjects in selector labels", () => {
  const [item] = commitSelectionItems([
    {
      sha: "a".repeat(40),
      title: "safe\u001b]52;c;Y2xpcGJvYXJk\u0007 subject",
    },
  ]);
  assert.equal(item?.value, "a".repeat(40));
  assert.equal(item?.label, `${"a".repeat(12)} safe subject`);
});

test("parses all direct targets and settings alias", () => {
  assert.deepEqual(parseReviewLoopArgs("uncommitted"), {
    action: "run",
    target: { type: "uncommitted" },
    extraInstruction: undefined,
  });
  assert.deepEqual(parseReviewLoopArgs(`branch main --extra="security only"`), {
    action: "run",
    target: { type: "baseBranch", branch: "main" },
    extraInstruction: "security only",
  });
  assert.deepEqual(parseReviewLoopArgs("commit abc title words"), {
    action: "run",
    target: { type: "commit", sha: "abc", title: "title words" },
    extraInstruction: undefined,
  });
  assert.deepEqual(parseReviewLoopArgs("pr 123"), {
    action: "run",
    target: { type: "pullRequest", reference: "123" },
    extraInstruction: undefined,
  });
  assert.deepEqual(parseReviewLoopArgs("folder src docs"), {
    action: "run",
    target: { type: "folder", paths: ["src", "docs"] },
    extraInstruction: undefined,
  });
  assert.deepEqual(parseReviewLoopArgs("setting"), { action: "settings" });
  assert.deepEqual(parseReviewLoopArgs("settings"), { action: "settings" });
});

test("rejects malformed arguments", () => {
  assert.throws(() => parseReviewLoopArgs("branch"), /exactly one/);
  assert.throws(() => parseReviewLoopArgs("pr 1 2"), /exactly one/);
  assert.throws(() => parseReviewLoopArgs("folder"), /at least one/);
  assert.throws(() => parseReviewLoopArgs("uncommitted --extra"), /Missing value/);
  assert.throws(() => parseReviewLoopArgs("wat"), /Unknown review target/);
  assert.throws(() => parseReviewLoopArgs("settings --extra x"), /does not accept/);
});

test("offers target and settings completions", () => {
  assert.equal(argumentCompletions("")?.length, 6);
  assert.deepEqual(
    argumentCompletions("set")?.map((item) => item.label),
    ["settings"],
  );
  assert.equal(argumentCompletions("branch m"), null);
});
