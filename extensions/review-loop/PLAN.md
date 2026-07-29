# `/loop-review` implementation plan

## Status

Implemented. The extension, package integration, safety guards, persistence, nested-session roles, renderers, and automated test suite now live in this directory.

## Goal

Add a `/loop-review` command that feels like a direct extension of
[`pi-review`](https://github.com/earendil-works/pi-review): select a review
target, review it, fix actionable findings, and repeat until a fresh review is
clean or a bounded safety condition stops the loop.

The normal command must remain minimal. Configuration belongs in
`/loop-review settings`, not in the target-selection flow.

## User experience

### Commands

```text
/loop-review
/loop-review uncommitted
/loop-review branch main
/loop-review commit abc123
/loop-review pr 123
/loop-review folder src docs
/loop-review settings
```

Also accept `setting` as an alias for `settings`. Argument completion should
offer target subcommands and `settings`.

### `/loop-review`

With no arguments, show only the target selector:

```text
Select a review target

> Review uncommitted changes
  Review against a base branch
  Review a commit
  Review a pull request
  Review a folder
```

Use the same smart default as `pi-review`:

1. Uncommitted changes when the worktree is dirty.
2. Base branch when on a non-default branch.
3. Commit otherwise.

After the target is resolved, start immediately. Do not show a setup summary or
second confirmation screen.

### `/loop-review settings`

Open a separate `SettingsList` containing:

```text
Reviewer model       current model
Reviewer thinking    current level
Fixer model          current model
Fixer thinking       current level
Maximum passes       4 (or unlimited)
Required clean runs  1
Fix P3 findings      yes
Fixer context        continuous
Verification command none
Review instructions  none
```

Selecting a model opens a searchable model picker. Selecting review
instructions or the verification command opens `ctx.ui.editor()`.

Settings save immediately. Store model references as provider/model IDs, never
model objects or credentials.

Initial persistence scope: global, in
`~/.pi/agent/review-loop.json` (resolved with `getAgentDir()`). Add project-local
overrides only after the core loop is stable.

`current model` and `current level` are dynamic defaults resolved from the
outer Pi session when a run begins.

### Running UI

Keep progress to one compact component:

```text
Review loop · pass 2/4 · fixing 3 findings
Esc to stop
```

Do not stream child-agent transcripts into the main chat. The component may
show a short error or blocked reason, but detailed results belong in the final
result entry.

### Final UI

Render one compact result card, expandable with Pi's normal tool/message detail
control:

```text
✓ Review loop clean · 3 passes · 5 findings fixed · checks passed
```

Terminal outcomes are:

- `clean`
- `blocked`
- `exhausted`
- `aborted`
- `failed`

An abort leaves completed file edits in place and reports that explicitly.

## Architecture decision

Use nested Pi SDK `AgentSession`s. Do not orchestrate the loop by repeatedly
calling `/review`, `/end-review`, changing the outer session model, or navigating
the visible session tree.

Reasons:

- Pi session branches isolate conversation history, not working-tree state.
- Reviewer/fixer messages should not pollute the user's main context.
- Reviewer and fixer models must not change the user's selected model.
- A command handler can directly await nested sessions and dispose them.
- In-memory sessions provide isolated context without creating resumable session
  files for every pass.

The default topology is:

```text
fresh reviewer -> persistent fixer -> verification -> fresh reviewer -> ...
```

### Reviewer

Create a new in-memory reviewer session for every pass. Give it:

- The frozen target descriptor and current target fingerprint.
- The review rubric adapted from `pi-review`.
- Trusted project context files and `REVIEW_GUIDELINES.md`.
- Shared review instructions and per-command `--extra` instructions.
- Read-only tools.
- A terminating structured review-result tool.

Do not give it prior review prose, prior finding outcomes, or fixer reasoning.
Every pass must independently inspect the complete current target against the
same frozen baseline.

Reviewer tools:

```text
read
grep
find
ls
review_target
submit_review
```

Do not expose `edit`, `write`, or unrestricted `bash` to the reviewer.
`review_target` should provide bounded, paginated access to status, changed
files, diff stats, and diffs using host-controlled Git commands.

### Fixer

Create the fixer lazily after the first actionable findings or failed
verification result.

Default to one persistent in-memory fixer session for the whole run. Give it:

```text
read
edit
write
grep
find
ls
submit_fix
```

Do not expose a generic shell to the fixer; verification commands run through the host.

Each fixer prompt contains:

- The frozen target descriptor.
- Current structured findings.
- Unresolved verification failures.
- A compact host-owned ledger of prior finding outcomes.
- Rules forbidding commit, checkout, reset, rebase, stash, clean, or branch
  changes.

When `Fixer context` is `fresh`, dispose and recreate the fixer for every fix
pass while supplying the same compact ledger.

The fresh reviewer, not the fixer's self-report, decides whether a fix worked.

### Child resources and models

Create child sessions with a controlled `DefaultResourceLoader`:

- Disable recursive extension and prompt-template discovery.
- Retain trusted project context files.
- Add the role prompt and review guidelines explicitly.
- Register only the role's custom tools.

Resolve selected models before making any edits. Preflight authentication for
both roles and fail with a concise message directing the user to
`/loop-review settings` when a model is unavailable.

Test extension-registered providers separately. If a selected provider exists
only through another extension, explicitly transfer/register that provider in
the child `ModelRuntime`; never silently fall back to a different model.

## Frozen target model

Resolve the target once, before the first review, and retain an immutable
`ReviewTargetSnapshot` for the entire run.

Common fields:

```ts
{
  type: "uncommitted" | "baseBranch" | "commit" | "pullRequest" | "folder";
  originalHead: string;
  originalBranch?: string;
  baseSha?: string;
  paths?: string[];
  pullRequest?: { number: number; title: string; baseBranch: string };
}
```

Before and after each fixer pass, verify that HEAD and the active branch still
match the snapshot. Unexpected changes block the loop.

### Uncommitted

- Freeze `HEAD` as `baseSha`.
- Review staged, unstaged, and untracked files.
- Re-review the complete current diff against the frozen `HEAD`, not only the
  latest fixer edits.

### Base branch

- Resolve and freeze the merge-base SHA once.
- Review the complete current worktree against that SHA on every pass.

### Pull request

- Reuse `pi-review`'s `gh` readiness, auth, and dirty-worktree checks.
- Check out the PR.
- Freeze its merge base and branch identity before starting the loop.

### Commit

Fixing an arbitrary historical commit in the current worktree is ambiguous.
For the initial implementation:

- Support commit loops only when the selected commit is current `HEAD`.
- Freeze its first parent as `baseSha`.
- Leave fixes uncommitted on top of the selected commit.
- Give a concise error for a non-HEAD commit rather than checking out or
  rewriting history automatically.

A temporary-worktree workflow can be designed later for historical commits.

### Folder

- Treat paths as a snapshot review, not a diff.
- Restrict findings and fixes to the selected paths.
- Skip diff-line-overlap validation.
- Keep the same configured pass policy because snapshot review can continually
  discover pre-existing issues; `unlimited` remains an explicit user choice.

## Structured protocols

Use custom terminating tools (`terminate: true`) rather than parsing Markdown.
Use `StringEnum` for enum fields for provider compatibility.

### Reviewer submission

```ts
interface ReviewSubmission {
  verdict: "clean" | "findings" | "blocked";
  findings: Array<{
    priority: "P0" | "P1" | "P2" | "P3";
    title: string;
    path: string;
    startLine: number;
    endLine: number;
    impact: string;
    evidence: string;
    suggestedFix: string;
  }>;
  humanCallouts: string[];
  blockedReason?: string;
}
```

Host validation:

- `clean` requires zero findings and no blocked reason.
- `findings` requires at least one finding.
- `blocked` never counts as clean.
- Paths must be relative, inside the repository, and inside folder scope when
  applicable.
- Diff-based finding locations must overlap a changed line in the current diff.
- Assign finding IDs in the host after validation.
- Cap field and collection sizes.
- Missing or invalid submission is a protocol failure, not a clean result.
- Retry one protocol failure in a new reviewer session, then block.

Build stable finding fingerprints from normalized path, location context,
priority, and title. Use them for deduplication and stagnation detection.

### Fixer submission

```ts
interface FixSubmission {
  status: "fixed" | "partial" | "blocked";
  outcomes: Array<{
    findingId: string;
    status: "fixed" | "invalid" | "deferred";
    explanation: string;
  }>;
  checksRun: Array<{
    command: string;
    exitCode: number;
  }>;
  summary: string;
}
```

Treat this as a progress report only. The host checks repository state and a
fresh reviewer validates the result.

Human reviewer callouts remain non-actionable and never enter the fix queue by
themselves.

## Orchestrator state machine

```text
idle
  -> resolving-target
  -> baseline-verification
  -> reviewing
       clean + checks pass -> clean-pass
       findings            -> fixing
       blocked              -> blocked
       invalid protocol     -> retry-review or blocked
  -> fixing
       changed/partial -> verifying
       blocked         -> blocked
  -> verifying
       pass -> reviewing
       fail -> fixing (bounded verification repair attempt)
  -> clean | blocked | exhausted | aborted | failed
```

Detailed flow:

1. Resolve settings, models, target, review guidelines, and Git invariants.
2. Run the configured verification command, if any, and record its output.
3. Start a fresh reviewer pass.
4. Validate and normalize its structured result.
5. If there are qualifying findings, send all of them to the fixer in priority
   order, including P3 by default.
6. Verify Git invariants and compute the new target fingerprint.
7. Run the configured verification command.
8. If verification fails, give the failure to the fixer before spending another
   reviewer pass. Bound these repair attempts.
9. Start another fresh reviewer over the complete current target.
10. Complete only when the configured number of clean fresh reviews and the
    verification gate apply to the same unchanged target fingerprint.

## Convergence and stop rules

A run is `clean` only when all of the following hold:

1. A fresh reviewer reports zero qualifying actionable findings.
2. No finding is deferred or blocked.
3. The configured verification command passes, when configured.
4. The target fingerprint has not changed since the clean review.
5. `Required clean runs` has been reached.

When no verification command is configured, label the result as review-clean
without deterministic verification in the expanded details.

Hard safeguards:

- Maximum review passes: configurable, default `4`.
- Reviewer protocol retries: `1`.
- Verification repair attempts per pass: `2`.
- Stop if the same finding fingerprints recur against an unchanged target.
- Stop if the fixer claims success but makes no relevant change and the same
  findings recur.
- Stop on unexpected branch or HEAD changes.
- Stop on child model/auth/tool failure after bounded retries.
- Escape aborts the active child session and command.

If `Fix P3 findings` is off, P3 findings are reported as intentionally excluded
and do not prevent threshold-based convergence. They must not disappear from
the final report.

## Safety

- Never automatically commit, reset, clean, stash, rebase, merge, or switch
  branches except the explicit `gh pr checkout` target flow inherited from
  `pi-review`.
- Never discard pre-existing user changes.
- Capture initial and final `git status` and diff fingerprints.
- Run only the user-configured verification command as a host convergence gate.
- Treat reviewer suggestions as untrusted data; the fixer must inspect the code
  independently.
- Do not persist credentials, raw reasoning, or complete child transcripts.
- Truncate all custom tool outputs using Pi's exported truncation helpers.
- Dispose every child session in `finally` blocks.

## Main-session persistence and rendering

Use custom entries for run state and a custom message for the final handoff:

- `review-loop-run-state`: target, phase, completed passes, fingerprints, and
  terminal status; excluded from LLM context.
- `review-loop-result`: concise final summary displayed with a custom renderer
  and included in future main-session context.

Only one loop may run at a time. On reload, any non-terminal persisted state is
marked `interrupted`; version one will not automatically resume it.

## Proposed file layout

```text
extensions/review-loop/
  PLAN.md
  README.md
  package.json
  tsconfig.json
  index.ts
  command.ts
  settings.ts
  models.ts
  targets.ts
  git.ts
  protocol.ts
  prompts.ts
  child-session.ts
  reviewer.ts
  fixer.ts
  orchestrator.ts
  ui.ts
  renderers.ts
  tests/
    args.test.ts
    settings.test.ts
    targets.test.ts
    diff-lines.test.ts
    protocol.test.ts
    orchestrator.test.ts
```

Keep Git/process logic, agent execution, and orchestration behind interfaces so
unit tests can use deterministic fake reviewer/fixer runners.

## Implementation phases

### Phase 1: package and command shell

- Add workspace package metadata, TypeScript config, and check scripts.
- Expose `index.ts` through the root Pi package manifest.
- Add the package to the root `pnpm check` pipeline.
- Register `/loop-review` with argument completion.
- Implement `settings`/`setting` routing before Git-repository checks.

Exit criteria:

- `/loop-review settings` opens independently.
- `/loop-review` shows only target choices.
- Direct target arguments parse consistently with `pi-review`.

### Phase 2: settings and compact UI

- Implement settings schema, validation, defaults, atomic persistence, and
  migration version.
- Build searchable model and supported-thinking-level pickers.
- Build the one-line cancellable progress component.
- Add result message/entry renderers.

Exit criteria:

- Settings survive restart.
- Invalid/unavailable model references fail clearly without fallback.
- Main-session model and thinking level never change.

### Phase 3: target resolution

- Adapt target parsing, smart defaults, branch/commit selectors, PR handling,
  project guideline discovery, and rubric from `pi-review`, with attribution.
- Freeze target snapshots and implement Git invariants.
- Implement bounded `review_target` operations and changed-line maps.

Exit criteria:

- All target types follow the policies above.
- Untracked files are included in uncommitted reviews.
- Base/PR merge bases remain fixed across passes.

### Phase 4: child agents and protocols

- Implement controlled child resource/model runtime creation.
- Implement fresh reviewer sessions and read-only tools.
- Implement persistent/fresh fixer modes.
- Implement terminating structured output tools and host validation.
- Aggregate child usage without exposing raw transcripts.

Exit criteria:

- Reviewer cannot mutate files through its active tools.
- Selected reviewer/fixer models are used independently.
- Invalid output cannot be mistaken for a clean review.

### Phase 5: loop orchestration

- Implement the state machine, finding ledger, deduplication, checks, clean-run
  count, optional pass limits, stagnation detection, and cancellation.
- Persist state at phase boundaries.
- Produce compact terminal result cards and detailed expanded reports.

Exit criteria:

- Findings are fixed and re-reviewed until convergence or a bounded stop.
- Repeated unchanged findings stop as blocked.
- Escape aborts promptly and preserves completed edits.

### Phase 6: hardening and documentation

- Add temporary-repository integration tests for each target.
- Test dirty PR checkout guards and branch/HEAD mutation detection.
- Test unavailable models and extension-registered providers.
- Document commands, settings, convergence semantics, and limitations.
- Run format, lint, typecheck, and Node test suites from the root check command.

## Test matrix

### Unit tests

- Argument tokenization, aliases, quoted `--extra`, and invalid arguments.
- Settings defaults, migrations, atomic writes, and corrupt-file errors.
- Model reference resolution and thinking-level clamping.
- Merge-base and default-branch resolution.
- Diff hunk parsing and changed-line overlap.
- Finding schema invariants, path safety, IDs, and deduplication.
- Every orchestrator transition and terminal state.
- Same-findings/same-fingerprint stagnation.
- P3 inclusion and exclusion behavior.

### Integration tests with temporary Git repositories

- Clean and dirty uncommitted targets, including untracked files.
- Branch review with a frozen merge base.
- HEAD commit review and non-HEAD rejection.
- Folder scope enforcement.
- PR command behavior with mocked `gh` output.
- Unexpected checkout/reset detection.
- Verification failure -> fixer -> pass -> fresh clean review.
- Abort during reviewer, fixer, and host verification.

### Agent-runner tests

Use fake sessions first, then opt-in live-model smoke tests:

- Reviewer finds multiple issues in one pass.
- Reviewer returns clean.
- Reviewer omits `submit_review`.
- Fixer reports fixed without changing files.
- Fixer partially fixes findings.
- A new finding appears after a fix.
- Context-continuous and fresh-fixer modes produce the same host state.

## Acceptance criteria

1. `/loop-review` contains no settings or setup screen—only target selection.
2. Selecting a target starts the loop immediately.
3. `/loop-review settings` owns all persistent configuration.
4. Reviewer and fixer models can differ without changing the outer Pi model.
5. Every reviewer pass uses a fresh, read-only in-memory session.
6. The fixer uses the configured context policy and mutation tools.
7. Structured output, not Markdown parsing, controls the loop.
8. Clean means a fresh clean review plus the configured verification policy on
   the same code state.
9. Finite runs are protected by pass, retry, and stagnation limits; an explicit
   `unlimited` pass setting still retains retry, stagnation, and cancellation guards.
10. Abort and failures never silently discard user work.
11. The final main-session output is compact but expandable.
12. Existing `/review` and `/end-review` continue to work unchanged.

## Deferred work

- Automatic resume of interrupted runs.
- Project-local settings overrides.
- Temporary worktrees for historical commit repair.
- Multiple reviewer models or consensus review.
- Automatic test-command discovery.
- Cost/time budgets and telemetry.
- Extracting a reusable review core upstream from `pi-review`.

## References

- [`pi-review`](https://github.com/earendil-works/pi-review)
- [Pi extension documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi SDK documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [Self-Refine](https://ar5iv.labs.arxiv.org/html/2303.17651)
- [Self-Preference Bias in LLM-as-a-Judge](https://arxiv.org/html/2410.21819v1)
- [Agentless](https://arxiv.org/html/2407.01489)
- [TestPrune](https://arxiv.org/html/2510.18270v2)
