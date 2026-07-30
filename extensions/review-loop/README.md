# Pi Review Loop

> Independent review → guarded fix → deterministic verification → fresh re-review, repeated until the target is convincingly clean or a safety bound stops the run.

`/loop-review` gives quality control its own isolated contexts. Reviewers never inherit a fixer's claims, fixer outcomes are treated as candidates until a later reviewer confirms the finding disappeared, and Git invariants prevent the target from moving underneath the loop.

## At a glance

|                    |                                                                         |
| ------------------ | ----------------------------------------------------------------------- |
| Command            | `/loop-review`                                                          |
| UI                 | Blocking TUI progress panel; `Esc` requests cancellation                |
| Default passes     | 4                                                                       |
| Default clean runs | 1                                                                       |
| Reviewer           | Fresh isolated `AgentSession` every pass, read-only tools               |
| Fixer              | Guarded edit/write tools; persistent context by default                 |
| Shell access       | Reviewer/fixer: none; optional verification runs separately on the host |
| Settings           | `~/.pi/agent/review-loop.json`                                          |

## Quick start

Review the current working-tree changes:

```text
/loop-review uncommitted
```

Review everything on the current feature branch relative to `main`:

```text
/loop-review branch main
```

Add one run-specific instruction without changing global settings:

```text
/loop-review uncommitted --extra "Prioritize authorization boundaries and missing regression tests"
```

Configure role models, reasoning, verification, and convergence:

```text
/loop-review settings
```

While a run is active, press `Esc` to stop. Completed edits remain in the worktree so no user work is silently discarded.

## Command reference

```text
/loop-review
/loop-review uncommitted
/loop-review branch <name>
/loop-review commit <revision> [display title]
/loop-review pr <number-or-github-url>
/loop-review folder <path...>
/loop-review settings
```

`setting` is accepted as an alias for `settings`.

Every run target accepts one quoted extra instruction:

```text
--extra "instruction"
--extra="instruction"
```

With no target, the TUI opens a selector with a smart default:

- dirty worktree → uncommitted changes;
- clean feature branch → default base branch;
- otherwise → current commit.

## Review targets

| Target              | What is reviewed and repaired                                         | Preconditions and important behavior                                                                |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `uncommitted`       | Unstaged tracked changes and untracked files relative to `HEAD`       | Staged changes are rejected; active branch required                                                 |
| `branch <name>`     | Current branch relative to its merge base with the named local branch | Base must differ from current branch; staged changes rejected                                       |
| `commit HEAD`       | The current `HEAD` commit relative to its first parent                | Clean worktree required; fixes remain uncommitted on top                                            |
| `pr <ref>`          | A GitHub PR relative to its frozen GitHub-reported base OID           | `gh` required; worktree must be completely clean, including ignored files; checks out the PR branch |
| `folder <paths...>` | Current snapshots of selected repository files/directories            | Paths must exist, resolve inside the repository, and avoid Git metadata; fixer is scope-guarded     |

Historical commit repair is deliberately unsupported. Selecting a historical commit reports the limitation rather than creating a temporary worktree or rewriting history.

### Pull-request targets

PR review uses `gh pr view` to freeze the exact head/base OIDs and `gh pr checkout` to switch to the PR branch. The checked-out branch remains active after the run. If target resolution fails after checkout begins, the extension attempts to restore the original branch and HEAD.

Repository-owned `AGENTS.md` and `CLAUDE.md` files are not trusted for a PR checkout. Context owned outside the repository remains available. A configured host verification command is skipped for untrusted PR code; because verification was requested but could not safely run, the result terminates as blocked rather than clean.

Install and authenticate GitHub CLI before using PR targets:

```bash
gh auth login
gh auth status
```

## How convergence works

A successful loop is stricter than “the fixer said it worked.”

1. **Freeze the target.** Record branch, HEAD, scope, initial status, and target fingerprints.
2. **Baseline verification.** Run the configured command before review, if any.
3. **Fresh review.** Start a new read-only reviewer session and require a structured verdict.
4. **Prioritize findings.** P0–P2 are actionable; P3 follows the `fixP3Findings` setting.
5. **Guarded repair.** Give actionable findings to the fixer without generic shell access.
6. **Verify.** Run the host command after changes. A failure gets at most two bounded repair attempts.
7. **Re-review independently.** A fixer-reported outcome is not confirmed until a later reliable review omits the same finding fingerprint.
8. **Require clean evidence.** A clean review, passing configured verification, unchanged target, and the configured count of clean runs are all required.

The loop blocks on recurring findings, target mutation during review, branch/HEAD changes, out-of-folder edits, deferred actionable findings, reviewer protocol failure, or exhausted repair limits.

## Finding priorities

| Priority | Meaning in the loop                                                    |
| -------- | ---------------------------------------------------------------------- |
| P0       | Critical correctness/security/data-loss issue; always actionable       |
| P1       | High-impact defect; always actionable                                  |
| P2       | Material issue worth fixing; always actionable                         |
| P3       | Lower-severity improvement; fixed or intentionally excluded by setting |

When P3 fixing is disabled, excluded findings remain visible in the final result instead of disappearing.

## Settings

Open the interactive editor:

```text
/loop-review settings
```

Settings persist globally in `~/.pi/agent/review-loop.json` by default.

| Setting              | Default          | Purpose                                                      |
| -------------------- | ---------------- | ------------------------------------------------------------ |
| Reviewer model       | Current Pi model | Independent diagnosis and structured findings                |
| Reviewer thinking    | Current Pi level | Reasoning used by fresh reviewer sessions                    |
| Fixer model          | Current Pi model | Guarded implementation role                                  |
| Fixer thinking       | Current Pi level | Reasoning used for repairs                                   |
| Maximum passes       | `4`              | Review-pass cap; 1–20 or `unlimited`                         |
| Required clean runs  | `1`              | Consecutive clean evidence required on an unchanged target   |
| Fix P3               | `true`           | Whether lower-severity findings are actionable               |
| Fixer context        | `continuous`     | Preserve fixer context across passes or use `fresh` context  |
| Verification command | unset            | Deterministic host command run at baseline and after changes |
| Review instructions  | unset            | Global rubric appended to reviewer prompts                   |

`current model` and `current level` are dynamic references: they resolve from the outer Pi session at run start. Explicit model settings store only `provider/model-id`, never credentials. Unsupported reasoning levels are resolved safely against the chosen model.

Example persisted configuration:

```json
{
  "version": 1,
  "reviewerModel": {
    "provider": "xai",
    "modelId": "grok-4.5"
  },
  "reviewerThinking": "high",
  "fixerModel": {
    "provider": "openai-codex",
    "modelId": "gpt-5.6-luna"
  },
  "fixerThinking": "high",
  "maximumPasses": 4,
  "requiredCleanRuns": 1,
  "fixP3Findings": true,
  "fixerContext": "continuous",
  "verificationCommand": "pnpm test",
  "reviewInstructions": "Prioritize correctness, security boundaries, and regression coverage."
}
```

Only configure models actually available to Pi.

## Verification

The verification command is a trusted local shell command configured by the user. It is separate from child-agent tools and runs from the repository root.

Good commands are deterministic and focused:

```text
pnpm test
pnpm --filter api check
cargo test -p affected_crate
pytest tests/auth
```

Avoid interactive, watch-mode, destructive, deployment, or credential-rotating commands. Output is bounded to the final 32 KiB. Cancellation terminates the process group where supported and escalates if necessary.

If no command is configured, a clean result means **review-clean**, not test-verified. The final renderer states this explicitly.

## Models and isolation

- Every reviewer pass gets a fresh in-memory session.
- The fixer is persistent by default so it can retain implementation context; `fresh` resets it each pass.
- Child sessions do not recursively load project extensions.
- Provider definitions and effective authentication are transferred from the already-resolved outer runtime.
- Child transcripts and hidden reasoning are not copied into the outer chat or saved as resumable Pi sessions.
- The final bounded handoff includes status, unresolved findings, verification failures, exclusions, and human callouts.

This separation prevents a fixer from grading its own work and keeps the outer conversation/model unchanged.

## Safety guarantees

The fixer can inspect and mutate files through guarded tools, but it has no generic shell. It cannot:

- stage or commit;
- checkout or switch branches;
- reset, restore, rebase, merge, or amend;
- stash or clean;
- push or force-push;
- rewrite Git history.

Additional invariants:

- HEAD and active branch must remain frozen after target resolution.
- Folder targets cannot mutate outside selected paths.
- Paths resolving through symlinks into `.git` or outside the repository are rejected.
- A read-only reviewer changing the target blocks the run.
- Aborting preserves completed edits and reports that edits may remain.
- Only one review loop runs per Pi session.

Review Loop improves confidence; it does not replace human review for security-critical or irreversible changes.

## Terminal statuses

| Status      | Meaning                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `clean`     | Required clean reviews and verification succeeded on an unchanged target                           |
| `blocked`   | A safety invariant, recurring issue, protocol problem, or verification bound prevented convergence |
| `exhausted` | Maximum passes ended before fresh clean evidence was available                                     |
| `aborted`   | User/session cancellation; completed edits were preserved                                          |
| `failed`    | Unexpected failure prevented a reliable result                                                     |

Expand the final custom message in Pi to inspect per-pass verdicts, finding ledger state, fixer summaries, verification output, model choices, usage, and cost.

## Recipes

### Security-focused review of local changes

```text
/loop-review uncommitted --extra "Trace trust boundaries, authz decisions, secret handling, and failure modes"
```

### Review a feature branch with stronger convergence

1. Open `/loop-review settings`.
2. Set `required clean runs` to 2 and a focused verification command.
3. Run:

```text
/loop-review branch main
```

### Review only two packages

```text
/loop-review folder packages/api packages/auth --extra "Ignore style-only comments"
```

### Inspect a PR without running untrusted checks

```text
/loop-review pr https://github.com/owner/repository/pull/123
```

Clear the verification command first if you want review-only PR behavior rather than an intentionally blocked result.

## Troubleshooting

### “Review targets do not support staged changes”

Unstage the files before starting. The loop repairs working-tree files and will not rewrite the index.

### “Commit review requires a clean worktree”

Commit, stash, or remove unrelated work. Commit mode only supports repairing current `HEAD` from a clean baseline.

### PR checkout is refused

PR targets require no tracked, untracked, **or ignored** worktree entries. This avoids losing local artifacts during `gh pr checkout`.

### The loop is blocked after a fixer said “fixed”

That is expected when no fresh reviewer has independently confirmed the finding disappeared, the finding recurred, or verification still fails.

### Verification was skipped for a PR

Host commands are not executed against an untrusted PR checkout. Remove the configured command for review-only behavior, or run trusted checks separately after inspecting the code.

### A model cannot be resolved

Open settings and choose an authenticated model currently visible to Pi, or switch the role back to `current model`.

## Current limitations

- Commit repair supports only current `HEAD`.
- Historical commit repair does not create temporary worktrees.
- Project-local settings overrides are not implemented.
- Interrupted runs are marked interrupted but cannot resume.
- PR checkout is the one intentional branch switch and remains active after a completed run.

## Development

```bash
pnpm --filter pi-review-loop check
pnpm --filter pi-review-loop format
```

After local changes, run `/reload` in Pi. Tests cover argument parsing, target safety, symlink/Git-metadata confinement, model resolution, reviewer pagination/protocols, fixer restrictions, verification cancellation, convergence, and custom rendering.

## Attribution

Target-selection behavior and the review rubric are adapted from [`pi-review`](https://github.com/earendil-works/pi-review), Copyright © 2026 Earendil Inc., under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
