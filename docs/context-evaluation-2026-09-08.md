# Context improvements and Grok 4.5 evaluation

2026-09-08. Follow-up to the [read-only production audit](context-session-audit-2026-09-08.md). The audit's findings are preserved; its publication copy redacts private identifiers and normalizes formatting. This report describes subsequent implementation and synthetic evaluation.

## Verdict

**The targeted retrieval improvements helped in this small controlled sample.** Stock compaction answered all requested facts in 1/3 scenarios; stock plus recall/notes and fresh windows each answered 3/3. All 18 transitions completed, including six verified fresh resets with automatic continuation. No provider or extension errors occurred.

Fresh windows were faster and used fewer total tokens than stock plus recall/notes here, but **used more input tokens than stock alone**. This is not evidence of universal cost savings, production reliability rates, or Astra-equivalent reasoning quality.

## Implemented

- Original user/tool evidence gets stable, presentation-only entry-ID markers. Assistant reasoning/signatures and persisted messages stay untouched; ambiguous/transformed sources are skipped. Guidance encourages source-linked named notes after meaningful findings, without quotas.
- `recall` gains composable role/tool/source/window filters. Previous means every earlier window. Pagination pins query, filters, ancestry and relative-window boundary; old unfiltered cursors remain supported.
- Local `context.event` records distinguish activation, requests, actual fresh/normal/other outcomes, reasons, cancellation/failure, continuation and subsequent successful input usage. No raw content or errors enter diagnostics. Terminal-hook writes avoid invalidating prepared branches; usage attribution survives reload and stays branch-local.
- Added real-Pi and deterministic regressions for evidence-linked notes across two resets, exact failed-output recovery, filter pagination/branch isolation, presentation-only provenance, telemetry safety and reload attribution. Existing steering, cancellation, corruption and fallback tests remain intact.

Interfaces and limitations: [README](../extensions/context/README.md). Sources: [extension](../extensions/context/index.ts), [retrieval](../extensions/context/model.ts), [provenance](../extensions/context/provenance.ts), [diagnostics](../extensions/context/diagnostics.ts), [real-host tests](../extensions/context/tests/host.test.ts).

## Experiment

[Runner](../extensions/context/evals/run.ts) · [machine-readable results, answers and diagnostics](context-eval-2026-09-08.json)

Nine task runs = three scenarios × three strategies, one trial per cell. Every task has two context transitions followed by the same final question for that scenario:

1. Preserve the one-Chrome/no-deploy/transaction constraints and a rejected partial-transaction retry design.
2. Recover `retry_boundary.spec.ts::preserves_outer_transaction`, expected `3`, actual `4`, and the failed savepoint approach from the middle of a long synthetic log.
3. Honor a late switch from `/work/old` to `/work/new`, read-only/diff-only permission, and no deployment despite a hostile external-text claim.

The harness seeds synthetic original history, including a tool log with the important evidence at line 84 of 180. Between transitions it adds unrelated staging results. Stock uses real Pi generated compaction. Stock+recall uses that same compaction with the new extension's resets disabled. Fresh uses a model-written solo checkpoint with `reset:true` and real automatic continuation; no generated summary on successful fresh transitions. All strategies are explicitly staged, not left to approach the model's full context limit.

**Model/auth:** `xai/grok-4.5`, low thinking, existing OAuth credential. The runner checks Pi's `isUsingOAuth` and `isUsingSubscription`, removes the xAI API-key environment fallback, and refuses another model/provider. It uses an in-memory credential/model store without custom models. User auth/settings files are not written. Pi 0.85.1 identifies xAI OAuth as “Grok/X subscription”; this verifies the selected auth route, not an independently observed billing ledger. No API-key route was used.

**Isolation/bounds:** separate temporary workspaces and persisted sessions; no user transcripts, context files, skills or extensions loaded. Only `recall`/`notes` are exposed in extension arms, and no tools in stock. The seeded `test_log` is historical synthetic evidence, not an executable tool. Maximum 14 model calls per task, 1,600 output tokens per call, three-minute task deadline, SDK automatic retries disabled. Temporary sessions were removed. Aggregate usage includes staging, generated summaries, checkpoints, retrieval turns, continuations and final answers—not only post-reset prompt sizes.

## Results

| Scenario                               |     Stock | Stock + recall/notes | Fresh + recall/notes |
| -------------------------------------- | --------: | -------------------: | -------------------: |
| Original constraints + rejected design | 3/4 facts |                  4/4 |                  4/4 |
| Exact failed-test evidence             |       0/4 |                  4/4 |                  4/4 |
| Latest worktree/permissions            |       4/4 |                  4/4 |                  4/4 |
| Complete scenarios                     |   **1/3** |              **3/3** |              **3/3** |

Stock's final constraint answer said no rejected approach was recorded. Its failure answer explicitly reported missing exact evidence after truncated tool-output preservation rather than fabricating the identifier/values. Both extension arms returned the exact rejected approach and failure details. All arms stated the latest worktree, read-only policy and no deployment.

Scoring uses fact-presence regexes and manual review of the saved final answers. The initial regex pass incorrectly rejected Markdown-emphasized `partial` and `Expected:`/`Actual:` values. We stripped emphasis/code markers and rescored **the same saved answers without new model calls**. JSON retains `rawChecks` alongside corrected `checks`; [scorer](../extensions/context/evals/score.ts) and [regression test](../extensions/context/tests/eval.test.ts) document the correction. Presence checks are not a general contradiction/safety judge.

### Aggregate work across three tasks per strategy

| Metric                                  |    Stock | Stock + recall/notes | Fresh + recall/notes |
| --------------------------------------- | -------: | -------------------: | -------------------: |
| Model calls                             |       18 |                   30 |                   17 |
| Input tokens incl. cache                |   32,773 |               94,364 |               50,963 |
| Output tokens                           |    3,628 |                6,341 |                2,114 |
| Cache-read tokens (subset of input)     |    5,504 |               26,368 |               12,800 |
| Elapsed seconds                         |     75.8 |                126.7 |                 49.2 |
| Recall tool calls                       |        0 |                    9 |                    4 |
| Notes tool calls, including checkpoints |        0 |                    8 |                    6 |
| Successful transitions                  | 6 normal |             6 normal |              6 fresh |

Total: **65 model calls, 251.8 seconds of task runtime**, nine tasks; no reruns. Fresh's next successful post-reset requests were 2,071–2,232 input tokens. These sizes are not directly comparable to Pi's `tokensBefore` estimate. Token counts are provider-reported, and **no dollar-cost estimate is presented**: catalog API prices would misrepresent subscription usage.

## What this does—and does not—establish

- Long-log details omitted during stock summarization can remain useful through original evidence and notes. In the constraint scenario the fresh arm made four recall calls; in the failure scenario it preserved the exact detail without later recall. Therefore this is not nine independent demonstrations of retrieval after omission.
- Successful fresh resets do not require an extra summarization model call, but checkpoints, tool schemas and retrieval still have overhead. Fresh used about 55% more input than stock alone in these trials, despite better fact recovery.
- The six fresh notes calls were checkpoint calls. **The experiment does not show spontaneous named-note adoption in the fresh arm.** The stock+recall arm made additional notes calls; the aggregate recorder does not classify their actions. Source-linked named-note mechanics are separately covered by deterministic real-host tests. The production-audit behavioral gap is reduced by guidance/provenance, not proven solved.
- The tasks evaluate final reported facts, not completed code changes, executable test success, avoidance of repeated actions, or malicious-action attempts. No edit/deploy tools were available. The hostile text was explicitly labeled untrusted, making that part an easy safety check.
- One model, one trial per cell, short synthetic histories, fixed strategy order, shared provider cache and explicitly prompted transitions. No confidence intervals, randomized order, natural budget-trigger study, full-window stress test, cross-model comparison or billing measurements. Do not extrapolate latency or token ratios to production.
- Offline tests exercise branch isolation, late steering, archive validation, fallback and actual host lifecycle. Those are deterministic mechanics checks, not paid-model quality scores. Further production observation is needed before claiming dependable incremental-note behavior.

## Validation

- Context package: formatting, lint, typecheck and **58 tests passed**.
- All workspace checks passed: **196 tests passed, one optional live-MCP test skipped**. Root lint/typecheck and four skill tests also passed.
- `git diff --check` passed. The initial top-level formatting gate flagged the original audit report; its publication copy was subsequently redacted and formatted before commit.

## Reproduce

```bash
bun run --filter pi-context check

# Explicit subscription usage; choose a new filename (existing results are protected).
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-new.json
```

Normal checks do not call a provider. The opt-in evaluation never logs raw provider errors or credentials. No deployment or user-session migration is part of this work.
