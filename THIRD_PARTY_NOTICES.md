# Third-party notices

The bundled skills originate from [Matt Pocock's `mattpocock/skills`](https://github.com/mattpocock/skills), under the MIT license reproduced below.

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

## Matt Pocock MIT license

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
