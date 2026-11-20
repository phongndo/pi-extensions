import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const SECTION = "environment";

/** `git status --porcelain=v2 --branch` → "branch main, 3 uncommitted files". */
export function describeGitStatus(porcelain: string): string {
  let branch = "unknown";
  let changes = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line && !line.startsWith("#")) changes++;
  }
  const head = branch === "(detached)" ? "detached HEAD" : `branch ${branch}`;
  return `${head}, ${changes === 0 ? "clean" : `${changes} uncommitted file${changes === 1 ? "" : "s"}`}`;
}

async function gitSummary(cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", cwd, "status", "--porcelain=v2", "--branch"], {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return `git: ${describeGitStatus(stdout)}`;
  } catch {
    return "git: not a repository";
  }
}

export async function describeEnvironment(cwd: string): Promise<string> {
  const os =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "linux"
        ? "Linux"
        : process.platform;
  return `host ${hostname().split(".")[0]} (${os}) · ${await gitSummary(cwd)} (at session start)`;
}

/**
 * Adds host and git state once per session, so the model skips an orientation
 * `pwd`/`git status` call. The section stays fixed for the session: a changing
 * section would append a prompt patch on every run.
 */
export default function envContext(pi: ExtensionAPI): void {
  let cached: { cwd: string; text: Promise<string> } | undefined;
  pi.on("session_start", () => {
    cached = undefined;
  });
  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    if (!cached || cached.cwd !== options.cwd)
      cached = { cwd: options.cwd, text: describeEnvironment(options.cwd) };
    options.sections[SECTION] = await cached.text;
  });
}
