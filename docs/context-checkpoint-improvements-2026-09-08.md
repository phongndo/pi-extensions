# Two modes and source-backed checkpoints

2026-09-08 · Context 0.4.0. Follow-up to the [efficiency/long-session report](context-efficiency-2026-09-08.md). Earlier mode tables and evaluation files are historical snapshots, not the current interface.

## Implemented

- `/context default`: ordinary Pi compaction, no memory tools/guidance/markers.
- `/context exp`: fresh windows + recall/notes, retaining ordinary compaction as a safety fallback.
- Removed the selectable memory-only experiment. Version-2 `exp-2` settings map to `exp`; removed `exp-1` settings map to `default`. Old files are read without rewriting them, and no notes/history are deleted. New settings use version 3. Canonical completions are default/exp/status; on/off remain hidden aliases. [State](../extensions/context/state.ts) · [control/lifecycle](../extensions/context/index.ts)

Checkpoint and note guidance now explicitly asks for:

1. **Verified / Attempted / Assumed distinctions**, including exact test identifiers/results and failed approaches. A drafted patch is not a tested fix.
2. Outstanding requests, latest steering/permissions, completed work, uncertainty and the next checks needed before declaring success.
3. Source IDs in the **`references` array**, not only prose. Inline citations are not automatically converted to references.
4. Detailed findings kept in named notes, not copied into every checkpoint.
5. Selective verification when an important source is missing, ambiguous or conflicting—not mandatory rereads, irrelevant citations or quotas.

The bootstrap adds compact source-type labels (`user`, `tool result, error`, `note`, etc.) to evidence IDs. This helps select the right source without inserting the original payload. The labels are explicitly **provenance, not proof of a claim**. No new mandatory fields, rigid status syntax, reference quotas or semantic-validation claims were added. [Guidance](../extensions/context/guidance.ts) · [bootstrap](../extensions/context/model.ts) · [README](../extensions/context/README.md)

The four always-on guidance/description strings total **2,121 characters** (not tokens, and excluding schemas), with a 2,150-character regression budget. The small increase over the lean version is deliberate: clearer uncertainty/source instructions take priority over shaving every word.

## Offline checks

Tests verify that checkpoint fields retain uncertainty and permissions, the latest user source is attached, source labels do not read/copy large tool payloads, and notes remain separately readable. Uncertain findings can still be saved without invented sources. Existing byte-for-byte Unicode recovery, disk reopen, branch isolation, stale-checkpoint, cancellation, fallback and real-host tests remain in place.

Mode tests cover default/exp switching, persistence/migration, rejection of removed commands, schema visibility, corrupt preferences, in-flight tools and shutdown cleanup. The real-Pi `exp` fallback still generates a stock summary when no checkpoint is available.

[Checkpoint tests](../extensions/context/tests/checkpoint-quality.test.ts) · [mode tests](../extensions/context/tests/modes.test.ts) · [host tests](../extensions/context/tests/host.test.ts)

## Short model checks: include the failure, not just the successes

Same three short scenarios and per-task budgets as before, now comparing **default vs exp**: Grok 4.5, low thinking, existing xAI OAuth subscription only, no API-key fallback. No private session material was uploaded. These are synthetic transition/recovery checks, not long-session quality benchmarks.

### Initial six-task batch

[Unmodified batch results](context-eval-2026-09-08-checkpoints.json)

| Scenario                                 | Default   | Exp                                                              |
| ---------------------------------------- | --------- | ---------------------------------------------------------------- |
| Original constraints + rejected approach | 3/4 facts | 4/4 facts; two fresh transitions                                 |
| Exact failing-test evidence              | 0/4 facts | **Incomplete: replied READY without requesting the first reset** |
| Latest worktree/permissions              | 4/4 facts | 4/4 facts; two fresh transitions                                 |

Exp therefore completed **2/3**, not 3/3, in this batch. The incomplete run made one model call, no notes call and no compaction. Its original history remained available; the harness stopped that cell because the required transition had not happened. This is a model-compliance failure, not demonstrated archive loss. The result file retains the original generic `run_failed` label; future runs classify this guard as `missing_transition`.

No provider or extension-hook errors occurred. All six runs passed both original-entry/evidence-projection comparisons and the newly recorded **disk-reopen original-entry comparison**. These integrity checks do not make model-written summaries semantically lossless.

Batch totals (do not compare the incomplete exp arm as equal completed work):

| Strategy | Calls | Input incl. cache | Output | Elapsed |
| -------- | ----: | ----------------: | -----: | ------: |
| Default  |    18 |            32,802 |  3,878 |   69.5s |
| Exp      |    11 |            31,315 |  1,257 |  145.2s |

### One bounded follow-up, kept separate

Review also found source IDs written in checkpoint prose but omitted from structured references. The instruction was clarified to say **“Put cited IDs in references, not only prose.”** No archive logic or transition forcing was added. Then only the failed `failure:exp` cell was repeated, with the same task/staging prompts and a separate output file.

[Follow-up result](context-eval-2026-09-08-checkpoint-repeat.json)

- Correct exact test ID, expected `3`, actual `4`, and failed savepoint approach: **4/4 facts**.
- Two fresh transitions; both stored checkpoints explicitly linked the original failed tool result and user sources in their reference arrays.
- Six model calls, 17,404 input tokens, 1,069 output tokens, 21.7 seconds.
- Three notes calls and two stored checkpoints. The recorder did not classify the extra attempt's tool-level outcome; do not read “no provider/hook errors” as a claim that every tool call succeeded.
- Persisted original entries and readable evidence remained unchanged.

The repeat is **not a replacement for the failed first trial**, and the wording change plus normal model variability means this does not prove a causal improvement. Status labels were not consistently emitted as literal Verified/Attempted/Assumed headings; they remain guidance, not a demonstrated universal model habit. There were no additional repeats after this one.

Total for this follow-up work: seven task runs, 35 model calls, approximately 236.5 seconds. No dollar-cost claim is made from subscription token counts.

## Conclusion

The source-linked checkpoint interface is clearer and more inspectable without rigid quotas or new tools. However, the skipped reset and omitted structured references show why successful mechanics alone do not establish dependable model behavior. Preserve the original archive and safety fallback; continue judging meaningful source use, uncertainty retention and completed work in daily sessions. Do not claim lossless semantic memory or universal token savings.

## Reproduce / validation

```bash
bun run --filter pi-context check

# Explicit subscription use, fresh output filenames required.
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-new.json
bun extensions/context/evals/run.ts --run-subscription --only=failure:exp --output=/tmp/context-eval-one.json
```

Context formatting/lint/typecheck and **74 tests passed**. All workspace checks and root lint/typecheck/skill tests passed: **216 tests passed, one optional live-MCP test skipped**. `git diff --check` passed. The original audit report was redacted and formatted for publication; the full root check now passes. User settings, credentials and files on the private audit host were not modified.
