import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fixerTools } from "../fixer.ts";
import {
  getChangedFiles,
  getDiffStat,
  getTargetDiff,
  GIT_STATUS_MAX_BYTES,
  GitClient,
  lineRangeOverlaps,
  outsideScopeFingerprint,
  parseChangedLines,
  repositoryFingerprint,
  targetFingerprint,
  type ExecGit,
  type StreamGit,
} from "../git.ts";
import type { ReviewTargetSnapshot } from "../models.ts";
import { resolveTarget } from "../targets.ts";

const execFileAsync = promisify(execFile);

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-loop-diff-lines-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
  return root;
}

function executor(): ExecGit {
  return async (command, args, options) => {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options?.cwd,
        signal: options?.signal,
        encoding: "utf8",
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message,
        code: typeof failure.code === "number" ? failure.code : 1,
        killed: false,
      };
    }
  };
}

test("caps Git status while streamed", async () => {
  const execute: ExecGit = async () => ({ stdout: "", stderr: "", code: 0, killed: false });
  const stream: StreamGit = async (_args, _options, onStdout) => {
    onStdout(Buffer.alloc(GIT_STATUS_MAX_BYTES));
    onStdout(Buffer.from("overflow"));
    return { stdout: "", stderr: "", code: 0 };
  };
  const git = new GitClient(execute, ".", undefined, stream);

  await assert.rejects(git.status(), /Git status exceeds.*safety limit/);
});

test("records changed lines without including unchanged hunk context", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,5 +1,5 @@",
    " one",
    " two",
    "-old",
    "+new",
    " four",
    " five",
  ].join("\n");
  const lines = parseChangedLines(diff);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 1, 1), false);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 3, 3), true);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 5, 5), false);
});

test("forces stable diff prefixes before parsing changed lines", async () => {
  const root = await repository({ "a.ts": "one\ntwo\nold\nfour\n" });
  await execFileAsync("git", ["config", "diff.mnemonicPrefix", "true"], { cwd: root });
  const baseSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  await writeFile(join(root, "a.ts"), "one\ntwo\nnew\nfour\n");
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: root,
    originalHead: baseSha,
    originalBranch: "main",
    baseSha,
  };

  const diff = await getTargetDiff(new GitClient(executor(), root), target, 0);

  assert.match(diff, /^--- a\/a\.ts$/m);
  assert.match(diff, /^\+\+\+ b\/a\.ts$/m);
  assert.equal(lineRangeOverlaps(parseChangedLines(diff), "a.ts", 3, 3), true);
});

test("generates changed lines against the final worktree", async () => {
  const calls: string[][] = [];
  const execute: ExecGit = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });
  const stream: StreamGit = async (args, _options, onStdout) => {
    calls.push(args);
    if (args.includes("diff")) {
      onStdout(
        Buffer.from(
          [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -2 +12 @@",
            "-old",
            "+new",
          ].join("\n"),
        ),
      );
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "baseBranch",
    repositoryRoot: "/repository",
    originalHead: "head",
    originalBranch: "feature",
    baseSha: "base",
    branch: "main",
  };

  const diff = await getTargetDiff(
    new GitClient(execute, target.repositoryRoot, undefined, stream),
    target,
    0,
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.includes("--cached"), false);
  assert.ok(calls[0]!.includes("base"));
  assert.ok(calls[1]!.includes("ls-files"));
  const lines = parseChangedLines(diff);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 2, 2), false);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 12, 12), true);
});

test("changed files and stats use the final base-to-worktree state", async () => {
  const root = await repository({ "a.txt": "base\n" });
  const baseSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  await writeFile(join(root, "a.txt"), "committed change\n");
  await execFileAsync("git", ["add", "a.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "change"], { cwd: root });
  const head = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  await writeFile(join(root, "a.txt"), "base\n");
  const target: ReviewTargetSnapshot = {
    type: "baseBranch",
    repositoryRoot: root,
    originalHead: head,
    originalBranch: "main",
    baseSha,
    branch: "base",
  };
  const git = new GitClient(async (command, args, options) => {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  }, root);

  assert.equal(await getTargetDiff(git, target), "");
  assert.deepEqual(await getChangedFiles(git, target), []);
  assert.equal(await getDiffStat(git, target), "Base to worktree: (empty)");
});

test("does not classify submodule-looking text in an ordinary file as a dirty submodule", async () => {
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  const root = await repository({ "notes.txt": `Subproject commit ${oldCommit}\n` });
  const baseSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  await writeFile(join(root, "notes.txt"), `Subproject commit ${newCommit}-dirty\n`);
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: root,
    originalHead: baseSha,
    originalBranch: "main",
    baseSha,
  };

  assert.match(await getTargetDiff(new GitClient(executor(), root), target), /Subproject commit/);
});

test("includes committed submodule changes and rejects dirty nested worktrees", async () => {
  const root = await repository({ "tracked.txt": "tracked\n" });
  await mkdir(join(root, "deps"));
  const submodule = join(root, "deps", "lib");
  await execFileAsync("git", ["init", "-b", "main", submodule]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: submodule });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: submodule });
  await writeFile(join(submodule, "value.txt"), "one\n");
  await execFileAsync("git", ["add", "."], { cwd: submodule });
  await execFileAsync("git", ["commit", "-m", "one"], { cwd: submodule });
  await writeFile(
    join(root, ".gitmodules"),
    ['[submodule "lib"]', "\tpath = deps/lib", "\turl = ./deps/lib", "\tignore = all", ""].join(
      "\n",
    ),
  );
  await execFileAsync("git", ["add", ".gitmodules", "deps/lib"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "add submodule"], { cwd: root });
  const baseSha = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  ).stdout.trim();
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: root,
    originalHead: baseSha,
    originalBranch: "main",
    baseSha,
  };
  const git = new GitClient(executor(), root);

  await writeFile(join(submodule, "value.txt"), "two\n");
  await execFileAsync("git", ["add", "."], { cwd: submodule });
  await execFileAsync("git", ["commit", "-m", "two"], { cwd: submodule });

  assert.match(await getTargetDiff(git, target), /Subproject commit/);
  assert.deepEqual(await getChangedFiles(git, target), ["deps/lib"]);
  assert.match(await getDiffStat(git, target), /deps\/lib/);
  const targetBefore = await targetFingerprint(git, target);
  const repositoryBefore = await repositoryFingerprint(git, root);
  const outsideBefore = await outsideScopeFingerprint(git, root, ["src"]);

  await writeFile(join(submodule, "value.txt"), "three\n");
  await execFileAsync("git", ["add", "."], { cwd: submodule });
  await execFileAsync("git", ["commit", "-m", "three"], { cwd: submodule });

  assert.notEqual(await targetFingerprint(git, target), targetBefore);
  assert.notEqual(await repositoryFingerprint(git, root), repositoryBefore);
  assert.notEqual(await outsideScopeFingerprint(git, root, ["src"]), outsideBefore);

  await writeFile(join(submodule, "value.txt"), "dirty\n");
  await assert.rejects(getTargetDiff(git, target), /dirty submodule worktree/i);
  await assert.rejects(targetFingerprint(git, target), /dirty submodule worktree/i);
  await assert.rejects(repositoryFingerprint(git, root), /dirty submodule worktree/i);
  await assert.rejects(outsideScopeFingerprint(git, root, ["src"]), /dirty submodule worktree/i);

  await writeFile(join(submodule, "value.txt"), "three\n");
  const nestedParent = join(submodule, "vendor");
  const nested = join(nestedParent, "nested");
  await mkdir(nestedParent);
  await execFileAsync("git", ["init", "-b", "main", nested]);
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: nested });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: nested });
  await writeFile(join(nested, "value.txt"), "nested\n");
  await execFileAsync("git", ["add", "."], { cwd: nested });
  await execFileAsync("git", ["commit", "-m", "nested"], { cwd: nested });
  await writeFile(
    join(submodule, ".gitmodules"),
    ['[submodule "nested"]', "\tpath = vendor/nested", "\turl = ./vendor/nested", ""].join("\n"),
  );
  await execFileAsync("git", ["add", ".gitmodules", "vendor/nested"], { cwd: submodule });
  await execFileAsync("git", ["commit", "-m", "add nested submodule"], { cwd: submodule });
  await assert.doesNotReject(getTargetDiff(git, target));

  await writeFile(join(nested, "untracked.txt"), "nested dirt\n");
  await assert.rejects(getTargetDiff(git, target), /dirty submodule worktree/i);
  await assert.rejects(repositoryFingerprint(git, root), /dirty submodule worktree/i);
});

test("retains initially untracked files after they become ignored", async () => {
  const root = await repository({ ".gitignore": "" });
  await writeFile(join(root, "bug.ts"), "export const broken = true;\n");
  const execute = executor();
  const target = await resolveTarget({ type: "uncommitted" }, { cwd: root, execute });
  const git = new GitClient(execute, root);

  await writeFile(join(root, ".gitignore"), "bug.ts\n");

  assert.match(await getTargetDiff(git, target), /diff --git "a\/bug\.ts" "b\/bug\.ts"/);
  assert.ok((await getChangedFiles(git, target)).includes("bug.ts"));
  assert.match(await getDiffStat(git, target), /bug\.ts/);
});

test("skips frozen untracked files deleted before diff listing", async () => {
  const root = await repository({ "tracked.txt": "tracked\n" });
  await writeFile(join(root, "initial.txt"), "initial\n");
  const execute = executor();
  const target = await resolveTarget({ type: "uncommitted" }, { cwd: root, execute });
  await writeFile(join(root, "retained.txt"), "retained\n");
  target.retainedUntrackedPaths = ["retained.txt"];
  const git = new GitClient(execute, root);
  const before = await targetFingerprint(git, target);
  await unlink(join(root, "initial.txt"));
  await unlink(join(root, "retained.txt"));

  assert.equal(await getTargetDiff(git, target), "");
  assert.deepEqual(await getChangedFiles(git, target), []);
  assert.equal(await getDiffStat(git, target), "Base to worktree: (empty)");
  assert.notEqual(await targetFingerprint(git, target), before);
});

test("rejects untracked files that disappear after Git lists them", async () => {
  const root = await repository({ "tracked.txt": "tracked\n" });
  await writeFile(join(root, "volatile.txt"), "volatile\n");
  const execute: ExecGit = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });
  const stream: StreamGit = async (args, _options, onStdout) => {
    if (args.includes("ls-files")) {
      onStdout(Buffer.from("volatile.txt\0"));
      await unlink(join(root, "volatile.txt"));
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: root,
    originalHead: "head",
    originalBranch: "main",
    baseSha: "head",
  };

  await assert.rejects(
    getTargetDiff(new GitClient(execute, root, undefined, stream), target),
    /Untracked file disappeared while generating diff: volatile\.txt/,
  );
});

test("retains fixer-created files after the fixer ignores them", async () => {
  const root = await repository({ ".gitignore": "" });
  const execute = executor();
  const target = await resolveTarget({ type: "uncommitted" }, { cwd: root, execute });
  const write = fixerTools(target, () => undefined).find((tool) => tool.name === "write")!;
  const context = {} as ExtensionContext;

  await write.execute(
    "create-generated",
    { path: "generated.ts", content: "export const generated = true;\n" },
    undefined,
    undefined,
    context,
  );
  await write.execute(
    "ignore-generated",
    { path: ".gitignore", content: "generated.ts\n" },
    undefined,
    undefined,
    context,
  );

  const git = new GitClient(execute, root);
  assert.match(
    await getTargetDiff(git, target),
    /diff --git "a\/generated\.ts" "b\/generated\.ts"/,
  );
  assert.ok((await getChangedFiles(git, target)).includes("generated.ts"));
  assert.match(await getDiffStat(git, target), /generated\.ts/);
  const before = await targetFingerprint(git, target);
  await writeFile(join(root, "generated.ts"), "export const generated = false;\n");
  assert.notEqual(await targetFingerprint(git, target), before);
});

test("parses added and deleted-file locations", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -2,2 +2,3 @@",
    "-old",
    "+new",
    "+extra",
    " context",
    "diff --git a/src/deleted.ts b/src/deleted.ts",
    "--- a/src/deleted.ts",
    "+++ /dev/null",
    "@@ -5,2 +0,0 @@",
    "-gone",
    "-also gone",
  ].join("\n");
  const lines = parseChangedLines(diff);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 2, 3), true);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 4, 4), false);
  assert.equal(lineRangeOverlaps(lines, "src/deleted.ts", 5, 6), true);
});

test("decodes Git C-style octal escapes in changed paths", () => {
  const lines = parseChangedLines(
    [
      '--- "a/src/control\\001.ts"',
      '+++ "b/src/control\\001.ts"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  );
  assert.equal(lineRangeOverlaps(lines, "src/control\u0001.ts", 1, 1), true);
});

test("maps deletion-only hunks to an adjacent current line", () => {
  const lines = parseChangedLines(
    ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -2,2 +2,1 @@", " context", "-removed"].join("\n"),
  );
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 2, 2), true);
  assert.equal(lineRangeOverlaps(lines, "src/a.ts", 3, 3), false);
});

test("maps context-zero middle and EOF deletions to surviving adjacent lines", async () => {
  const root = await repository({ "a.txt": "one\ntwo\nthree\nfour\nfive\n" });

  await writeFile(join(root, "a.txt"), "one\ntwo\nfour\nfive\n");
  const middleDiff = (
    await execFileAsync("git", ["diff", "--unified=0", "--", "a.txt"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout;
  const middleLines = parseChangedLines(middleDiff);
  assert.equal(lineRangeOverlaps(middleLines, "a.txt", 2, 2), true);
  assert.equal(lineRangeOverlaps(middleLines, "a.txt", 1, 1), false);

  await writeFile(join(root, "a.txt"), "one\ntwo\nthree\nfour\n");
  const eofDiff = (
    await execFileAsync("git", ["diff", "--unified=0", "--", "a.txt"], {
      cwd: root,
      encoding: "utf8",
    })
  ).stdout;
  const eofLines = parseChangedLines(eofDiff);
  assert.equal(lineRangeOverlaps(eofLines, "a.txt", 4, 4), true);
  assert.equal(lineRangeOverlaps(eofLines, "a.txt", 1, 1), false);
});

test("uses prototype-free storage for inherited-property filenames", () => {
  const lines = parseChangedLines(
    [
      "--- a/__proto__",
      "+++ b/__proto__",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/constructor b/constructor",
      "--- a/constructor",
      "+++ b/constructor",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n"),
  );
  assert.equal(lineRangeOverlaps(lines, "__proto__", 1, 1), true);
  assert.equal(lineRangeOverlaps(lines, "constructor", 1, 1), true);
});

test(
  "maps chmod-only diffs to a synthetic file-level location",
  { skip: process.platform === "win32" },
  async () => {
    const root = await repository({ "script.sh": "#!/bin/sh\necho ok\n" });
    await chmod(join(root, "script.sh"), 0o755);
    const diff = (
      await execFileAsync("git", ["diff", "--binary", "--unified=0", "--", "script.sh"], {
        cwd: root,
        encoding: "utf8",
      })
    ).stdout;
    assert.match(diff, /old mode/);
    const lines = parseChangedLines(diff, ["script.sh"]);
    assert.equal(lineRangeOverlaps(lines, "script.sh", 1, 1), true);
  },
);

test("uses hardened options for target and safety diffs", async () => {
  const calls: string[][] = [];
  const execute: ExecGit = async (_command, args) => {
    calls.push(args);
    return {
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    };
  };
  const stream: StreamGit = async (args) => {
    calls.push(args);
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: "/repository",
    originalHead: "head",
    originalBranch: "main",
    baseSha: "head",
  };
  const git = new GitClient(execute, target.repositoryRoot, undefined, stream);

  await getTargetDiff(git, target);
  await getChangedFiles(git, target);
  await getDiffStat(git, target);
  await repositoryFingerprint(git, target.repositoryRoot);
  await outsideScopeFingerprint(git, target.repositoryRoot, ["src"]);

  const diffCalls = calls.filter((args) => args.includes("diff"));
  assert.equal(diffCalls.length, 7);
  assert.ok(diffCalls.every((args) => args.includes("--no-textconv")));
  assert.ok(diffCalls.every((args) => args.includes("--ignore-submodules=none")));
  assert.ok(diffCalls.every((args) => args.includes("--submodule=short")));
  const targetPatchCall = diffCalls.find((args) =>
    args.some((argument) => argument.startsWith("--unified=")),
  );
  assert.ok(targetPatchCall?.includes("--src-prefix=a/"));
  assert.ok(targetPatchCall?.includes("--dst-prefix=b/"));
  const safetyCalls = diffCalls.filter(
    (args) => args.includes("--binary") && !args.includes("--no-renames"),
  );
  assert.equal(safetyCalls.length, 4);
  assert.ok(safetyCalls.every((args) => args.includes("--no-ext-diff")));
});

test("stops consuming an oversized target diff as it is generated", async () => {
  const execute: ExecGit = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });
  let chunksGenerated = 0;
  const stream: StreamGit = async (_args, _options, onStdout) => {
    for (let index = 0; index < 4; index += 1) {
      chunksGenerated += 1;
      onStdout(Buffer.alloc(4 * 1024 * 1024));
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: "/repository",
    originalHead: "head",
    originalBranch: "main",
    baseSha: "head",
  };
  await assert.rejects(
    getTargetDiff(new GitClient(execute, target.repositoryRoot, undefined, stream), target),
    /8 MiB safety limit/,
  );
  assert.equal(chunksGenerated, 3);
});

test("bounds untracked files before generating their patches", async () => {
  const execute: ExecGit = async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
  });
  let diffProcesses = 0;
  const stream: StreamGit = async (args, _options, onStdout) => {
    if (args.includes("diff")) diffProcesses += 1;
    if (args.includes("ls-files")) {
      onStdout(
        Buffer.from(
          `${Array.from({ length: 1_001 }, (_value, index) => `file-${index}.txt`).join("\0")}\0`,
        ),
      );
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: "/repository",
    originalHead: "head",
    originalBranch: "main",
    baseSha: "head",
  };

  await assert.rejects(
    getTargetDiff(new GitClient(execute, target.repositoryRoot, undefined, stream), target),
    /1000-file safety limit/,
  );
  assert.equal(diffProcesses, 1);
});

test("generates untracked patches in process", async () => {
  const root = await repository({ "tracked.txt": "tracked\n" });
  await writeFile(join(root, "file name.md"), "one\ntwo\n");
  const calls: string[][] = [];
  const stream: StreamGit = async (args, _options, onStdout) => {
    calls.push(args);
    if (args.includes("ls-files")) onStdout(Buffer.from("file name.md\0"));
    return { stdout: "", stderr: "", code: 0 };
  };
  const target: ReviewTargetSnapshot = {
    type: "uncommitted",
    repositoryRoot: root,
    originalHead: "head",
    originalBranch: "main",
    baseSha: "head",
  };
  const diff = await getTargetDiff(
    new GitClient(
      async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      root,
      undefined,
      stream,
    ),
    target,
  );

  assert.equal(calls.filter((args) => args.includes("diff")).length, 1);
  assert.match(diff, /\+\+\+ "b\/file name\.md"/);
  assert.equal(lineRangeOverlaps(parseChangedLines(diff), "file name.md", 2, 2), true);
});

test("supports untracked patches and paths with spaces", () => {
  const lines = parseChangedLines(
    ["--- /dev/null", "+++ b/docs/file name.md", "@@ -0,0 +1,2 @@", "+one", "+two"].join("\n"),
  );
  assert.equal(lineRangeOverlaps(lines, "docs/file name.md", 2, 2), true);
});
