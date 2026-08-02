import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRepositoryInspectionTools } from "../inspection-tools.ts";
import {
  directoryContainsGitMetadata,
  GIT_CONTROL_FILE_MAX_BYTES,
  repositoryInspectionPath,
} from "../path-safety.ts";

const execFileAsync = promisify(execFile);

async function fixture(): Promise<{ root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), "review-loop-inspection-"));
  const root = join(parent, "repository");
  const outside = join(parent, "secret.txt");
  await mkdir(root);
  await writeFile(join(root, "inside.txt"), "inside\n", "utf8");
  await writeFile(outside, "secret\n", "utf8");
  await symlink(outside, join(root, "link.txt"));
  return { root, outside };
}

test("inspection paths must remain repository-relative after resolving symlinks", async () => {
  const { root, outside } = await fixture();
  assert.equal(await repositoryInspectionPath(root, "inside.txt"), "./inside.txt");
  await assert.rejects(repositoryInspectionPath(root, outside), /relative to the repository/);
  await assert.rejects(repositoryInspectionPath(root, "../secret.txt"), /escapes the repository/);
  await assert.rejects(repositoryInspectionPath(root, "link.txt"), /outside the repository/);
});

test("inspection fails closed for malformed metadata in another subtree", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "unrelated", "deep"), { recursive: true });
  await writeFile(join(root, "unrelated", "deep", ".git"), "gitdir: missing\n", "utf8");

  await assert.rejects(repositoryInspectionPath(root, "inside.txt"), /ENOENT|metadata/i);
});

test("inspection fails closed after resolving a gitdir with an invalid commondir", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "metadata"));
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", ".git"), "gitdir: ../metadata\n", "utf8");
  await writeFile(join(root, "metadata", "commondir"), "../missing-common\n", "utf8");

  await assert.rejects(repositoryInspectionPath(root, "inside.txt"), /ENOENT|metadata/i);
});

test("inspection paths cannot be reinterpreted as home-relative by SDK tools", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "~"));
  await writeFile(join(root, "~", "inside.txt"), "inside\n", "utf8");
  await writeFile(join(root, "@inside.txt"), "inside\n", "utf8");
  assert.equal(await repositoryInspectionPath(root, "~/inside.txt"), "./~/inside.txt");
  assert.equal(await repositoryInspectionPath(root, "@inside.txt"), "./@inside.txt");
});

test("inspection paths reject Git metadata and recursive metadata ancestors", async () => {
  const { root } = await fixture();
  await mkdir(join(root, ".git"));
  await writeFile(join(root, ".git", "config"), "secret\n", "utf8");
  await symlink(".git", join(root, "metadata"));

  await assert.rejects(repositoryInspectionPath(root, ".git/config"), /Git metadata/);
  await assert.rejects(repositoryInspectionPath(root, "metadata/config"), /Git metadata/);
  await assert.rejects(repositoryInspectionPath(root, ".", true), /Git metadata/);
  assert.equal(await repositoryInspectionPath(root, "."), ".");

  const recursiveInputs: Record<string, Record<string, unknown>> = {
    grep: { pattern: "secret" },
    find: { pattern: "*" },
  };
  for (const tool of createRepositoryInspectionTools(root).filter(
    (candidate) => candidate.name === "grep" || candidate.name === "find",
  )) {
    await assert.rejects(
      tool.execute(
        "test",
        recursiveInputs[tool.name]!,
        undefined,
        undefined,
        {} as ExtensionContext,
      ),
      /Git metadata/,
    );
  }
});

test("inspection paths reject nested Git metadata and its aliases", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "vendor", "clone", ".git"), { recursive: true });
  await writeFile(join(root, "vendor", "clone", ".git", "config"), "secret\n", "utf8");
  await symlink("clone/.git", join(root, "vendor", "metadata"));
  await mkdir(join(root, "vendor", "linked-gitdir"));
  await mkdir(join(root, "vendor", "linked-worktree"));
  await writeFile(
    join(root, "vendor", "linked-worktree", ".git"),
    "gitdir: ../linked-gitdir\n",
    "utf8",
  );
  await writeFile(join(root, "vendor", "linked-gitdir", "config"), "secret\n", "utf8");

  await assert.rejects(repositoryInspectionPath(root, "vendor/clone/.git/config"), /Git metadata/);
  await assert.rejects(repositoryInspectionPath(root, "vendor/metadata/config"), /Git metadata/);
  await assert.rejects(
    repositoryInspectionPath(root, "vendor/linked-gitdir/config"),
    /Git metadata/,
  );
  await assert.rejects(repositoryInspectionPath(root, "vendor", true), /Git metadata/);
});

test("inspection rejects repository-wide nested worktree aliases", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "metadata", "gitdir"), { recursive: true });
  await writeFile(join(root, "metadata", "gitdir", "config"), "secret\n", "utf8");
  await mkdir(join(root, "vendor", "deep", "worktree"), { recursive: true });
  await writeFile(
    join(root, "vendor", "deep", "worktree", ".git"),
    "gitdir: ../../../metadata/gitdir\n",
    "utf8",
  );

  await assert.rejects(repositoryInspectionPath(root, "metadata/gitdir/config"), /Git metadata/);
});

test("caps nested gitdir and commondir control files", async () => {
  const oversizedGitDir = await fixture();
  await writeFile(
    join(oversizedGitDir.root, ".git"),
    Buffer.alloc(GIT_CONTROL_FILE_MAX_BYTES + 1, "x"),
  );
  await assert.rejects(
    repositoryInspectionPath(oversizedGitDir.root, "inside.txt"),
    /control file exceeds its byte safety limit/,
  );

  const oversizedCommonDir = await fixture();
  await mkdir(join(oversizedCommonDir.root, "metadata"));
  await writeFile(join(oversizedCommonDir.root, ".git"), "gitdir: metadata\n", "utf8");
  await writeFile(
    join(oversizedCommonDir.root, "metadata", "commondir"),
    Buffer.alloc(GIT_CONTROL_FILE_MAX_BYTES + 1, "x"),
  );
  await assert.rejects(
    repositoryInspectionPath(oversizedCommonDir.root, "inside.txt"),
    /control file exceeds its byte safety limit/,
  );
});

test("does not charge ordinary dependency files against the metadata scan budget", async () => {
  const { root } = await fixture();
  const packageDirectory = join(root, "node_modules", "package");
  await mkdir(packageDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: 32 }, (_value, index) =>
      writeFile(join(packageDirectory, `${index}.js`), "export {};\n", "utf8"),
    ),
  );

  assert.equal(
    await directoryContainsGitMetadata(packageDirectory, undefined, { maxEntries: 0 }),
    false,
  );
  assert.equal(await repositoryInspectionPath(root, "inside.txt"), "./inside.txt");
});

test("recursive Git metadata scans are bounded and abort-aware", async () => {
  const { root } = await fixture();
  await mkdir(join(root, "large", "one", "two"), { recursive: true });
  await assert.rejects(
    directoryContainsGitMetadata(join(root, "large"), undefined, { maxEntries: 1 }),
    /entry safety limit/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    directoryContainsGitMetadata(join(root, "large"), undefined, {
      signal: controller.signal,
    }),
    /aborted/i,
  );
});

test(
  "read inspection rejects FIFOs before invoking the SDK tool",
  { skip: process.platform === "win32" },
  async () => {
    const { root } = await fixture();
    await execFileAsync("mkfifo", [join(root, "pipe")]);
    const read = createRepositoryInspectionTools(root).find((tool) => tool.name === "read")!;

    await assert.rejects(
      read.execute("test", { path: "pipe" }, undefined, undefined, {} as ExtensionContext),
      /regular file/,
    );
  },
);

test("all child inspection tools reject absolute paths", async () => {
  const { root, outside } = await fixture();
  const inputs: Record<string, Record<string, unknown>> = {
    read: { path: outside },
    grep: { pattern: "secret", path: outside },
    find: { pattern: "*", path: outside },
    ls: { path: outside },
  };
  for (const tool of createRepositoryInspectionTools(root)) {
    await assert.rejects(
      tool.execute("test", inputs[tool.name]!, undefined, undefined, {} as ExtensionContext),
      /relative to the repository/,
    );
  }
});
