import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertMutationPath, fixerTools, snapshotIgnoredPaths } from "../fixer.ts";
import type { ReviewTargetSnapshot } from "../models.ts";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "review-loop-fixer-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await mkdir(join(root, "src"));
  await mkdir(join(root, "other"));
  await writeFile(join(root, "other", "value.txt"), "one\n", "utf8");
  return root;
}

function target(root: string, paths?: string[]): ReviewTargetSnapshot {
  return {
    type: paths ? "folder" : "uncommitted",
    repositoryRoot: root,
    originalHead: "abc123",
    originalBranch: "main",
    paths,
  };
}

test("does not expose a generic shell to the fixer", async () => {
  const root = await fixture();
  const names = fixerTools(target(root), () => undefined).map((tool) => tool.name);
  assert.ok(!names.includes("bash"));
});

test("writes literal paths beginning with @", async () => {
  const root = await fixture();
  const write = fixerTools(target(root), () => undefined).find((tool) => tool.name === "write")!;
  await write.execute(
    "test",
    { path: "@created.txt", content: "literal\n" },
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.equal(await readFile(join(root, "@created.txt"), "utf8"), "literal\n");
  await assert.rejects(readFile(join(root, "created.txt"), "utf8"));
});

test("rejects ignored paths for diff targets but permits selected folder paths", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), ".env\nignored/\n", "utf8");
  await writeFile(join(root, ".env"), "secret=user-value\n", "utf8");
  await symlink(".env", join(root, "environment"));

  await assert.rejects(assertMutationPath(target(root), ".env"), /ignored path/);
  await assert.rejects(assertMutationPath(target(root), "environment"), /ignored path/);
  await assert.rejects(assertMutationPath(target(root), "ignored/new.txt"), /ignored path/);
  await assert.doesNotReject(assertMutationPath(target(root, ["."]), ".env"));
});

test("keeps initially ignored paths protected after ignore rules change", async () => {
  const root = await fixture();
  await writeFile(join(root, ".gitignore"), ".env\nignored/\n", "utf8");
  await writeFile(join(root, ".env"), "secret=user-value\n", "utf8");
  await mkdir(join(root, "ignored"));
  await writeFile(join(root, "ignored", "value.txt"), "private\n", "utf8");
  const initiallyIgnored = await snapshotIgnoredPaths(root);

  await writeFile(join(root, ".gitignore"), "", "utf8");
  await assert.rejects(assertMutationPath(target(root), ".env", initiallyIgnored), /ignored path/);
  await assert.rejects(
    assertMutationPath(target(root), "ignored/value.txt", initiallyIgnored),
    /ignored path/,
  );
});

test("rejects direct and symlinked Git metadata mutation paths", async () => {
  const root = await fixture();
  await symlink(".git", join(root, "metadata"));

  await assert.rejects(assertMutationPath(target(root), ".git/HEAD"), /Git metadata/);
  await assert.rejects(assertMutationPath(target(root), "metadata/HEAD"), /Git metadata/);
});

test("rejects nested Git metadata and its aliases", async () => {
  const root = await fixture();
  await mkdir(join(root, "other", "clone", ".git"), { recursive: true });
  await writeFile(join(root, "other", "clone", ".git", "config"), "secret\n", "utf8");
  await symlink("clone/.git", join(root, "other", "metadata"));
  await mkdir(join(root, "other", "linked-gitdir"));
  await mkdir(join(root, "other", "linked-worktree"));
  await writeFile(
    join(root, "other", "linked-worktree", ".git"),
    "gitdir: ../linked-gitdir\n",
    "utf8",
  );
  await writeFile(join(root, "other", "linked-gitdir", "config"), "secret\n", "utf8");

  await assert.rejects(assertMutationPath(target(root), "other/clone/.git/config"), /Git metadata/);
  await assert.rejects(assertMutationPath(target(root), "other/metadata/config"), /Git metadata/);
  await assert.rejects(
    assertMutationPath(target(root), "other/linked-gitdir/config"),
    /Git metadata/,
  );
});

test("a new fixer turn can invalidate metadata scans after host changes", async () => {
  const root = await fixture();
  await mkdir(join(root, "metadata", "gitdir"), { recursive: true });
  await writeFile(join(root, "metadata", "gitdir", "config"), "ordinary\n", "utf8");
  const metadataCache = new Map<string, readonly string[]>();
  await assert.doesNotReject(
    assertMutationPath(target(root), "metadata/gitdir/config", [], undefined, metadataCache),
  );
  assert.ok(metadataCache.size > 0);

  await mkdir(join(root, "vendor", "deep", "worktree"), { recursive: true });
  await writeFile(
    join(root, "vendor", "deep", "worktree", ".git"),
    "gitdir: ../../../metadata/gitdir\n",
    "utf8",
  );
  metadataCache.clear();

  await assert.rejects(
    assertMutationPath(target(root), "metadata/gitdir/config", [], undefined, metadataCache),
    /Git metadata/,
  );
});

test("rejects metadata aliased by a distant nested worktree", async () => {
  const root = await fixture();
  await mkdir(join(root, "metadata", "gitdir"), { recursive: true });
  await writeFile(join(root, "metadata", "gitdir", "config"), "secret\n", "utf8");
  await mkdir(join(root, "vendor", "deep", "worktree"), { recursive: true });
  await writeFile(
    join(root, "vendor", "deep", "worktree", ".git"),
    "gitdir: ../../../metadata/gitdir\n",
    "utf8",
  );

  await assert.rejects(assertMutationPath(target(root), "metadata/gitdir/config"), /Git metadata/);
});

test("rejects metadata referenced by a Git worktree file", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-worktree-"));
  await mkdir(join(root, "metadata"));
  await writeFile(join(root, ".git"), "gitdir: metadata\n", "utf8");
  await writeFile(join(root, "metadata", "HEAD"), "ref: refs/heads/main\n", "utf8");

  await assert.rejects(assertMutationPath(target(root), "metadata/HEAD"), /Git metadata/);
});

test("enforces folder scope after resolving symlinks", async () => {
  const root = await fixture();
  await symlink("../other/value.txt", join(root, "src", "link.txt"));
  await symlink("other", join(root, "selected"));

  await assert.rejects(
    assertMutationPath(target(root, ["src"]), "src/link.txt"),
    /through a symlink/,
  );
  await assert.doesNotReject(assertMutationPath(target(root, ["selected"]), "selected/value.txt"));
  await assert.doesNotReject(assertMutationPath(target(root, ["src"]), "src/new.txt"));
});
