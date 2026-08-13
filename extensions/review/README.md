# Pi Review

One extension provides two complementary review workflows while preserving their existing commands and behavior:

| Workflow                     | Commands                 | Use it for                                                                |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Interactive review branch    | `/review`, `/end-review` | One review pass with an optional structured handoff or queued fix turn    |
| Bounded independent fix loop | `/loop-review`           | Standard or parallel specialized review, guarded repair, and verification |

## Interactive review with `/review`

Start directly or open the target selector:

```text
/review
/review uncommitted
/review branch main
/review commit abc123 [display title]
/review pr <number-or-github-url>
/review folder src docs
/review branch main --extra "Focus on performance and error handling"
/settings-review
```

For an existing conversation, choose **Empty branch** to isolate the review or **Current session** to review inline. Interactive review trusts the agent's normal tools and user extensions—including Git through Bash and FFF/`fffind`/`ffgrep` when installed—and does not add a review-specific tool to the main agent. `/loop-review` is unavailable on an active empty review branch. Empty-branch reviews finish with:

```text
/end-review
```

The completion menu can return without a summary, return with a structured findings summary, or return and queue the findings for fixing. `/end-review` applies only to an Empty-branch review.

The `/review` selector also lets you add or remove session-persisted custom review instructions. In the target selector, press `1`–`5` to choose the corresponding target immediately. A `REVIEW_GUIDELINES.md` next to the nearest ancestor `.pi` directory is appended when present. PR review requires authenticated GitHub CLI access and refuses checkout when tracked changes or ignored files are present. Ordinary untracked files retain the original `pi-review` behavior and do not block checkout.

## Bounded review/fix loop with `/loop-review`

> Independent review panel → candidate verification → guarded fix → deterministic verification → fresh re-review, repeated until the target is convincingly clean or a safety bound stops the run.

The finding verifier never sees panel transcripts or provenance, reviewers never inherit a fixer's claims, fixer outcomes remain candidates until a later reviewer confirms the finding disappeared, and Git invariants prevent the target from moving underneath the loop.

|                    |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| UI                 | Blocking TUI progress panel; `Esc` requests cancellation                                     |
| Default passes     | 4                                                                                            |
| Default clean runs | 1                                                                                            |
| Reviewer           | Fresh isolated `AgentSession` per panel member; user extensions + tools minus `edit`/`write` |
| Fixer              | Guarded edit/write tools; persistent context by default                                      |
| Shell access       | Reviewer: general Bash + inherited tools; fixer: none; verification on host                  |
| Settings           | `~/.pi/agent/review-loop.json`                                                               |

## Quick start

Review the current working-tree changes:

```text
/loop-review uncommitted
```

Review everything on the current feature branch relative to `main`:

```text
/loop-review branch main
```

Run the configured blind adversarial review panel in parallel:

```text
/loop-review uncommitted --mode adversarial
```

Add one run-specific instruction without changing global settings:

```text
/loop-review uncommitted --mode adversarial --extra "Prioritize authorization boundaries and missing regression tests"
```

Configure the review mode, parallel agent count, role models, reasoning, verification, and convergence:

```text
/settings-review
```

`/loop-review settings` remains available as a compatibility alias.

While a run is active, press `Esc` to stop. Completed edits remain in the worktree so no user work is silently discarded.

## Command reference

```text
/loop-review
/loop-review uncommitted
/loop-review branch <name>
/loop-review commit <revision> [display title]
/loop-review pr <number-or-github-url>
/loop-review folder <path...>
/loop-review <target> --mode <standard|adversarial>
/settings-review
```

`/loop-review settings` remains available for compatibility, including its `setting` alias.

Every run target accepts a mode override and one quoted extra instruction:

```text
--mode adversarial
--mode=adversarial
--extra "instruction"
--extra="instruction"
```

## Review modes

| Mode          | Reviewer assignment                                               |
| ------------- | ----------------------------------------------------------------- |
| `standard`    | Balanced general review                                           |
| `adversarial` | Assume the change is wrong and prove a concrete way that it fails |

The **Review agents** setting controls how many independent sessions run concurrently on every pass (1–8). In adversarial mode every session gets the same brief in a fresh context, matching the Claude Code workflow: inspect the change without the author's reasoning and independently find the way it is wrong.

Parallel panel members inspect the same frozen fingerprint in independent sessions and cannot see one another's findings. The host unions exact distinct findings instead of majority-voting away findings reported by only one reviewer. Duplicate findings retain reviewer provenance.

With no target, the TUI opens a selector with a smart default. Press `1`–`5` to choose the corresponding target immediately:

- dirty worktree → uncommitted changes;
- clean feature branch → default base branch;
- otherwise → current commit.

## Review Loop targets

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
3. **Fresh review panel.** Start the configured number of new reviewer sessions. Panel members run concurrently against the same fingerprint and require a structured verdict from every member.
4. **Aggregate candidate findings.** Union and deduplicate panel findings without majority-voting away single-reviewer reports.
5. **Verify candidate findings independently.** Start a separate fresh read-only session that checks every candidate against the actual code. Confirmed findings continue, concretely disproved findings are retained as invalid, and uncertain findings block rather than disappearing or reaching the fixer.
6. **Prioritize.** P0–P2 confirmed findings are actionable and confirmed P3 follows the `fixP3Findings` setting.
7. **Guarded repair.** Give only confirmed actionable findings to the fixer without generic shell access.
8. **Run deterministic verification.** Run the configured host command after changes. A failure gets at most two bounded repair attempts.
9. **Re-review independently.** A fixer-reported outcome is not confirmed until a later reliable review omits the same finding fingerprint.
10. **Require clean evidence.** The aggregated panel must have no confirmed actionable findings, candidate verification must have no uncertainty, configured deterministic verification must pass, the target must remain unchanged, and the configured count of clean panel runs must be reached.

The loop blocks on recurring findings, uncertain candidate verification, target mutation during review or verification, branch/HEAD changes, out-of-folder edits, deferred actionable findings, reviewer/verifier protocol failure, or exhausted repair limits.

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
/settings-review
```

The legacy `/loop-review settings` route opens the same editor.

Settings persist globally in `~/.pi/agent/review-loop.json` by default.

| Setting              | Default          | Purpose                                                      |
| -------------------- | ---------------- | ------------------------------------------------------------ |
| Review mode          | `standard`       | Select reviewer specialization and strategy                  |
| Review agents        | `1`              | Independent reviewer sessions launched concurrently; 1–8     |
| Reviewer model       | Current Pi model | Model used by every independent review-panel member          |
| Reviewer thinking    | Current Pi level | Reasoning used by fresh reviewer sessions                    |
| Verifier model       | Current Pi model | Independent candidate-finding verification role              |
| Verifier thinking    | Current Pi level | Reasoning used by fresh verifier sessions                    |
| Fixer model          | Current Pi model | Guarded implementation role                                  |
| Fixer thinking       | Current Pi level | Reasoning used for repairs                                   |
| Maximum passes       | `4`              | Review-pass cap; 1–20 or `unlimited`                         |
| Required clean runs  | `1`              | Consecutive clean evidence required on an unchanged target   |
| Fix P3               | `true`           | Whether lower-severity findings are actionable               |
| Fixer context        | `continuous`     | Preserve fixer context across passes or use `fresh` context  |
| Verification command | unset            | Deterministic host command run at baseline and after changes |
| Review instructions  | unset            | Global rubric appended to reviewer prompts                   |

`current model` and `current level` are dynamic references: they resolve from the outer Pi session at run start. Explicit model settings store only `provider/model-id`, never credentials. When a selected model does not support the configured reasoning level, the settings UI immediately lowers it to that model's highest supported level; run-time resolution applies the same safe clamp for dynamic current-model references.

Settings schema version 3 introduced independent verifier model and thinking settings. Version 2 files migrate by copying their reviewer role into the verifier role, preserving previous behavior; version 1 and pre-versioned files migrate through the same path. Older extension releases cannot consume a version 3 file; downgrade by moving `review-loop.json` aside and letting that release regenerate its defaults.

Example persisted configuration:

```json
{
  "version": 3,
  "reviewMode": "adversarial",
  "reviewerCount": 4,
  "reviewerModel": {
    "provider": "xai",
    "modelId": "grok-4.5"
  },
  "reviewerThinking": "high",
  "verifierModel": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-6"
  },
  "verifierThinking": "high",
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

- Every panel member gets a fresh in-memory session and its review assignment.
- Parallel reviewers inspect the same frozen fingerprint without seeing each other's output.
- Every non-empty candidate set gets a separate fresh finding-verifier session. It sees structured candidates but not panel transcripts, hidden reasoning, prior outcomes, fixer context, or reviewer-count provenance.
- The verifier must concretely establish a finding to confirm it and concretely disprove it to reject it; uncertainty blocks the loop.
- Reviewers and finding verifiers inherit the outer session's active tools and normal user-level extensions (including FFF when installed). Project extensions remain disabled.
- Only `edit` and `write` are removed from the inherited active set. Reviewers and finding verifiers still receive unrestricted general Bash for inspection, tests, and Git history. Their prompts forbid mutations; the host rejects convergence if the target changes during either stage.
- Review-panel members use the configured reviewer model, the finding verifier uses its separately configured verifier model, and repairs use the fixer model.
- The fixer is persistent by default so it can retain implementation context; `fresh` resets it each pass.
- Child sessions do not recursively load project extensions.
- Provider definitions and effective authentication are transferred from the already-resolved outer runtime.
- Child transcripts and hidden reasoning are not copied into the outer chat or saved as resumable Pi sessions.
- The final bounded handoff includes status, unresolved findings, verification failures, exclusions, and human callouts.

This separation prevents a fixer from grading its own work and keeps the outer conversation/model unchanged.

## Safety guarantees

Reviewer/verifier Bash and inherited user extensions run with the user's permissions. These roles are instructed to use Bash only for inspection, tests, and read-only Git history; Bash is not technically read-only. A target fingerprint change blocks convergence but cannot undo shell or extension side effects.

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
- A reviewer or finding verifier changing the target blocks the run.
- Aborting preserves completed edits and reports that edits may remain.
- Only one review loop runs per Pi session.
- Repository fingerprints include ignored worktree files. When an ignored tree exceeds the descendant safety cap (for example a large `node_modules`), the host falls back to collapsed ignored directory roots instead of aborting.

Review Loop improves confidence; it does not replace human review for security-critical or irreversible changes.

## Terminal statuses

| Status      | Meaning                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `clean`     | No candidate survived independent finding verification as actionable, and deterministic verification succeeded on an unchanged target |
| `blocked`   | A safety invariant, recurring issue, protocol problem, or verification bound prevented convergence                                    |
| `exhausted` | Maximum passes ended before fresh clean evidence was available                                                                        |
| `aborted`   | User/session cancellation; completed edits were preserved                                                                             |
| `failed`    | Unexpected failure prevented a reliable result                                                                                        |

Expand the final custom message in Pi to inspect per-pass verdicts, finding ledger state, fixer summaries, verification output, model choices, usage, and cost.

## Recipes

### Security-focused review of local changes

```text
/loop-review uncommitted --mode adversarial --extra "Trace trust boundaries, authz decisions, secret handling, and failure modes"
```

### Review a feature branch with stronger convergence

1. Open `/settings-review`.
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

That is expected when no fresh reviewer panel has independently confirmed the finding disappeared, the finding recurred, or verification still fails.

### Verification was skipped for a PR

Host commands are not executed against an untrusted PR checkout. Remove the configured command for review-only behavior, or run trusted checks separately after inspecting the code.

### A model cannot be resolved

Open settings and choose an authenticated model currently visible to Pi, or switch the role back to `current model`.

## Current limitations

- Commit repair supports only current `HEAD`.
- Historical commit repair does not create temporary worktrees.
- Project-local settings overrides are not implemented.
- All parallel panel members currently share one configured reviewer model.
- Interrupted runs are marked interrupted but cannot resume.
- PR checkout is the one intentional branch switch and remains active after a completed run.

## Development

```bash
pnpm --filter pi-review check
pnpm --filter pi-review format
```

After local changes, run `/reload` in Pi. Tests cover argument parsing, target safety, symlink/Git-metadata confinement, model resolution, reviewer and finding-verifier prompting/protocols, fixer restrictions, verification cancellation, convergence, and custom rendering.

## Attribution

The `/review` implementation was incorporated from [`pi-review`](https://github.com/earendil-works/pi-review) commit `f1de050504936046c0f85b21fec0e0a93ef394eb`. Review Loop target-selection behavior and its review rubric were also adapted from that project. Copyright © 2026 Earendil Inc., under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
