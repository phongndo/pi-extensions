# Third-party notices

The imported Matt Pocock skills below originate from [`mattpocock/skills`](https://github.com/mattpocock/skills), under the MIT license reproduced below. The restored `yeet` and `autopilot` workflows are listed separately.

## grill-me and grilling

[`skills/grill-me/SKILL.md`](skills/grill-me/SKILL.md) is adapted from commit [`85f83d3fde1d3a90d5c9a657f6998c79a6c37308`](https://github.com/mattpocock/skills/commit/85f83d3fde1d3a90d5c9a657f6998c79a6c37308). The adaptation replaces the upstream agent's Skill-tool terminology with semantic skill invocation. Its [`skills/grilling/SKILL.md`](skills/grilling/SKILL.md) dependency is adapted from the same commit to batch settled-prerequisite interview questions through the available interactive question tool (or one question per turn when unavailable). The design tree, fact/decision boundary, and final human confirmation are preserved.

## handoff

[`skills/handoff/SKILL.md`](skills/handoff/SKILL.md) is adapted from commit [`d28dfdc39beadc3142a33359b5cfa4765dcbd0bc`](https://github.com/mattpocock/skills/commit/d28dfdc39beadc3142a33359b5cfa4765dcbd0bc). The adaptation replaces the upstream agent's Skill-tool terminology with semantic skill invocation.

## teach

[`skills/teach/`](skills/teach/) is copied from commit [`6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`](https://github.com/mattpocock/skills/commit/6654f6b60cd9d5be8b54c6fafe44346dabeb3b76), including the skill and its supporting workspace-format documents.

## Engineering and writing skills

These skills originate from commit [`3cca18b368ae95cdbdebbff572ccafa662551015`](https://github.com/mattpocock/skills/commit/3cca18b368ae95cdbdebbff572ccafa662551015):

- [`skills/diagnosing-bugs/`](skills/diagnosing-bugs/) and [`skills/resolving-merge-conflicts/`](skills/resolving-merge-conflicts/) retain the upstream workflows, including the diagnosis HITL script.
- [`skills/wizard/`](skills/wizard/) is adapted to name skills without harness-specific command syntax. Its bash template additionally stops input gates on EOF and reports missing browser openers.
- [`skills/research/`](skills/research/) is adapted to use available web tools and avoid nested research agents.
- [`skills/codebase-design/`](skills/codebase-design/) contains the Markdown from upstream `skills/engineering/codebase-design`, including `DEEPENING.md` and `DESIGN-IT-TWICE.md`.
- [`skills/writing-for-agents/`](skills/writing-for-agents/) contains the Markdown from upstream `skills/productivity/writing-for-agents`, including `SKILL-MECHANICS.md`.

The two newly imported bundles preserve substantive wording; repository formatting may differ. Their upstream Codex display-metadata sidecars are not included: agent-specific distribution remains owned by nix-config's existing chezmoi adapters.

## yeet

[`skills/yeet/`](skills/yeet/) restores this repository's manual publishing workflow, introduced in commit [`7b3b497`](https://github.com/phongndo/pi-extensions/commit/7b3b497e5191aba899a9c31e76190f7d1134ca01). It is not a Matt Pocock import. The restoration requires full staged-diff inspection; publishing remains separate from the explicitly requested `autopilot` merge-readiness workflow.

## autopilot

[`skills/autopilot/SKILL.md`](skills/autopilot/SKILL.md) is adapted from Cursor's built-in `autopilot` skill, as confirmed by the owner and compared with the installed Cursor Agent `2026.09.02-c22c1a3` copy at `~/.cursor/skills-cursor/autopilot/SKILL.md`. See [Cursor's built-in skills documentation](https://cursor.com/docs/skills#built-in-cursor-skills). The local adaptation adds explicit human invocation, current-session execution, and work-preservation guardrails while retaining the conflict → review → CI loop. No standalone upstream license or original source revision has been established; the MIT notices here do not purport to license Cursor's material. Review redistribution rights before publishing this personal skill bundle.

## Matt Pocock MIT license

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## show-me

[`skills/show-me/SKILL.md`](skills/show-me/SKILL.md) is adapted from [HumanLayer's `humanlayer/skills`](https://github.com/humanlayer/skills) at commit [`6ab9013a10c28f5046f7f999549cd5328a0b30d7`](https://github.com/humanlayer/skills/commit/6ab9013a10c28f5046f7f999549cd5328a0b30d7).

The adaptation replaces the upstream `Bash(open ...)` notation with available-shell instructions and macOS/Linux desktop openers.

MIT License

Copyright (c) 2026 HumanLayer

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
