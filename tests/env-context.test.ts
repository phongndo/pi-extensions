import { expect, test } from "bun:test";
import { describeEnvironment, describeGitStatus } from "../extensions/env-context/index.ts";

test("summarizes branch and uncommitted files from porcelain v2", () => {
  const out = [
    "# branch.oid 2867765",
    "# branch.head main",
    "# branch.upstream origin/main",
    "1 .M N... 100644 100644 100644 a b README.md",
    "? extensions/advisor/",
    "",
  ].join("\n");
  expect(describeGitStatus(out)).toBe("branch main, 2 uncommitted files");
  expect(describeGitStatus("# branch.head main\n")).toBe("branch main, clean");
  expect(describeGitStatus("# branch.head (detached)\n1 M. x\n")).toBe(
    "detached HEAD, 1 uncommitted file",
  );
});

test("reports a directory outside git", async () => {
  expect(await describeEnvironment("/")).toMatch(/^host \S+ \(\w+\) · git: not a repository/);
});
