import assert from "node:assert/strict";
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

test("Pi package resource paths have one owner", () => {
  const { pi } = JSON.parse(readFileSync("package.json", "utf8"));
  for (const paths of Object.values(pi)) assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(pi.skills, ["./skills"]);
  assert.deepEqual(pi.themes, ["./themes"]);
  assert.equal(pi.extensions.filter((path) => path === "./src/index.ts").length, 1);
});
