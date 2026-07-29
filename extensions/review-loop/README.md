# pi-review-loop

`/loop-review` runs a bounded, independent review → fix → verify → re-review workflow without changing the model or conversation of the outer Pi session.

## Commands

```text
/loop-review
/loop-review uncommitted
/loop-review branch main
/loop-review commit HEAD
/loop-review pr 123
/loop-review folder src docs
/loop-review settings
```

Use `--extra "instruction"` with any review target. `setting` is an alias for `settings`.

With no target argument, the command shows only a target selector. Its default is uncommitted changes for a dirty worktree, the default base branch on a feature branch, and the current commit otherwise.

## Settings

`/loop-review settings` persists global configuration in `~/.pi/agent/review-loop.json`:

- reviewer model and thinking level
- fixer model and thinking level
- maximum review passes (default 4, optionally `unlimited`)
- required clean runs (default 1)
- whether P3 findings are fixed (default yes)
- continuous or fresh fixer context
- an optional host verification command
- shared review instructions

`current model` and `current level` resolve dynamically from the outer session when a run starts. Stored model references contain only provider/model IDs; credentials are never written to this file.

## Child sessions and extensions

Every reviewer pass uses a fresh in-memory `AgentSession`; the fixer is persistent by default. Child roles execute no extensions, because project extension code may be part of the mutable review target and extension hooks are not constrained by tool allowlists. Role-model providers and effective authentication are transferred from the already-resolved outer runtime instead. The reviewer receives only repository inspection tools, while the fixer receives guarded mutation tools.

Repository-owned `AGENTS.md` and `CLAUDE.md` files are omitted for pull-request targets because project trust was established before the untrusted PR checkout. Context owned outside the repository remains available.

Child transcripts and reasoning are not copied into the outer chat, and child sessions do not create resumable session files. While the loop runs, its blocking progress panel keeps Pi's standard `Working...` marker visible and removes it on every exit. This lets terminal workspace managers that use Pi's visible screen-state convention classify the custom command as active without a service-specific integration.

## Convergence and safety

A run is clean only when a fresh reviewer has no qualifying findings, the configured verification command passes, the target remains unchanged, and the required clean-run count is met. Finite pass limits, protocol retries, verification-repair limits, recurring-finding detection, cancellation, and branch/HEAD invariants stop bounded runs; `unlimited` removes only the pass cap. Configured verification is skipped for untrusted pull-request checkouts, so those runs terminate as blocked rather than clean.

The fixer has no generic shell and cannot stage, commit, checkout, reset, restore, rebase, stash, clean, merge, or otherwise rewrite Git history. Guarded edit/write tools remain available, and verification runs separately through the host. Pull-request checkout is the sole explicit branch switch. An abort preserves completed edits and reports that fact.

Initial limitations:

- commit repair supports only the current `HEAD`; fixes remain uncommitted on top
- project-local settings overrides and interrupted-run resume are not implemented
- historical commit repair does not create temporary worktrees

## Attribution

Target-selection behavior and the review rubric are adapted from [`pi-review`](https://github.com/earendil-works/pi-review), Copyright © 2026 Earendil Inc., under the MIT License.
