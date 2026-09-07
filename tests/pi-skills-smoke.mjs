// Installed Pi, no credentials, no network requests, no model-driven side effects.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(".");
const expected = JSON.parse(readFileSync(join(root, "package.json"))).pi;
const names = (await import("node:fs/promises")).readdir(join(root, "skills"));
const home = mkdtempSync(join(tmpdir(), "pi-skill-smoke-"));
const agentDir = join(home, ".pi/agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    packages: [root],
    enableSkillCommands: true,
    enableInstallTelemetry: false,
    retry: { enabled: false },
    defaultProvider: "skill-smoke",
    defaultModel: "offline",
  }),
);
const probe = join(home, "probe.ts");
writeFileSync(
  probe,
  `
import { writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerProvider("skill-smoke", {
    baseUrl: "http://127.0.0.1:9", apiKey: "not-a-credential", api: "openai-completions",
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1 }],
    streamSimple() { throw new Error("Offline test: deliberately no model execution"); }
  });
  pi.on("before_agent_start", event => {
    writeFileSync(${JSON.stringify(join(home, "expanded.json"))}, JSON.stringify({
      prompt: event.prompt, skills: event.systemPromptOptions.skills
    }));
  });
}
`,
);
const child = spawn(
  process.env.PI_BIN || "pi",
  ["--offline", "--mode", "rpc", "--no-session", "--no-context-files", "-e", probe],
  {
    cwd: home,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
let buffer = "",
  stderr = "";
const events = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    try {
      events.push(JSON.parse(line));
    } catch {
      /* Ignore startup notices. */
    }
  }
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const index = events.findIndex(predicate);
    if (index !== -1) return events.splice(index, 1)[0];
    if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Pi timed out: ${stderr}\n${JSON.stringify(events).slice(-2000)}`);
}
let id = 0;
async function request(type, fields = {}) {
  const key = String(++id);
  child.stdin.write(JSON.stringify({ id: key, type, ...fields }) + "\n");
  const response = await waitFor((event) => event.type === "response" && event.id === key);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}
async function expand(message) {
  await request("prompt", { message });
  await waitFor((event) => event.type === "agent_settled");
  return JSON.parse(readFileSync(join(home, "expanded.json"), "utf8"));
}
try {
  const { commands } = await request("get_commands");
  const skills = commands.filter((command) => command.source === "skill");
  assert.deepEqual(
    skills.map((skill) => skill.name).sort(),
    (await names).map((name) => `skill:${name}`).sort(),
  );
  for (const name of ["wayfinder", "grill-me", "handoff", "autopilot", "yeet"]) {
    assert.equal(
      commands.filter((command) => command.source === "extension" && command.name === name).length,
      1,
    );
    const canonical = await expand(`/skill:${name} smoke argument`);
    const alias = await expand(`/${name} smoke argument`);
    assert.equal(alias.prompt, canonical.prompt);
    assert.ok(alias.prompt.includes(join(root, "skills", name)));
    assert.ok(alias.prompt.includes("smoke argument"));
    assert.equal(alias.skills.length, (await names).length);
  }
  assert.equal(events.filter((event) => event.type === "extension_error").length, 0);
  console.log(
    `PASS: Pi ${execFileSync(process.env.PI_BIN || "pi", ["--version"], { encoding: "utf8" }).trim()}; ${(await names).length} skills once; all five aliases equal native expansion. ${expected.extensions.length} packaged extension entry points.`,
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
  rmSync(home, { recursive: true, force: true });
}
