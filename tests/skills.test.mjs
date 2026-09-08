import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export const expectedSkills = [
  "autopilot",
  "bro",
  "diagnosing-bugs",
  "domain-modeling",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "handoff",
  "prototype",
  "research",
  "resolving-merge-conflicts",
  "setup-matt-pocock-skills",
  "show-me",
  "teach",
  "wayfinder",
  "wizard",
  "yeet",
].sort();

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("canonical inventory, native parser, and portable supporting files", () => {
  assert.deepEqual(readdirSync("skills").sort(), expectedSkills);
  const result = loadSkillsFromDir({ dir: "skills", source: "test" });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skills.map((skill) => skill.name).sort(), expectedSkills);
  for (const file of files("skills")) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\/skill:|Bash\(open|~\/\.pi/);
  }
  for (const file of [
    "diagnosing-bugs/scripts/hitl-loop.template.sh",
    "wizard/template.sh",
    "prototype/UI.md",
    "prototype/LOGIC.md",
    "domain-modeling/ADR-FORMAT.md",
    "domain-modeling/CONTEXT-FORMAT.md",
    "teach/MISSION-FORMAT.md",
    "teach/RESOURCES-FORMAT.md",
    "teach/GLOSSARY-FORMAT.md",
    "teach/LEARNING-RECORD-FORMAT.md",
    "setup-matt-pocock-skills/domain.md",
    "setup-matt-pocock-skills/issue-tracker-github.md",
    "setup-matt-pocock-skills/issue-tracker-gitlab.md",
    "setup-matt-pocock-skills/issue-tracker-local.md",
    "setup-matt-pocock-skills/triage-labels.md",
  ])
    assert.ok(readFileSync(`skills/${file}`).length);
  const notices = readFileSync("THIRD_PARTY_NOTICES.md", "utf8");
  for (const owner of ["Matt Pocock", "HumanLayer", "Dillon Mulroy", "Cursor"])
    assert.ok(notices.includes(owner));
});

test("wizard input gates stop on EOF instead of proceeding without a human", () => {
  const library = readFileSync("skills/wizard/template.sh", "utf8").split("\n# STAGES:")[0];
  for (const command of ['pause "Continue?"', 'ask VALUE "Value:"', 'ask_secret VALUE "Secret:"']) {
    const result = spawnSync(
      "bash",
      ["-c", `${library}\n${command}\nprintf 'UNEXPECTED_CONTINUATION'`],
      {
        input: "",
        encoding: "utf8",
        env: { ...process.env, ENV_FILE: "/dev/null" },
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, command);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_CONTINUATION/);
    const answered = spawnSync("bash", ["-c", `${library}\n${command}\nprintf 'CONTINUED'`], {
      input: "\n",
      encoding: "utf8",
      env: { ...process.env, ENV_FILE: "/dev/null" },
    });
    assert.equal(answered.status, 0, command);
    assert.match(answered.stdout, /CONTINUED/);
  }
});

test("wizard reports when no browser opener is available", () => {
  const library = readFileSync("skills/wizard/template.sh", "utf8").split("\n# STAGES:")[0];
  const result = spawnSync(
    "bash",
    ["-c", `${library}\nPATH=''\nopen_url https://example.invalid`],
    {
      input: "",
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /visit it manually/);
});

test("Pi package resource paths have one owner", () => {
  const { pi } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const paths of Object.values(pi)) assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(pi.skills, ["./skills"]);
  assert.deepEqual(pi.themes, ["./themes"]);
  assert.equal(pi.extensions.filter((path) => path === "./src/index.ts").length, 1);
});
