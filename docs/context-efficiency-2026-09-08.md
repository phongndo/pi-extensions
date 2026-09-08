# Context efficiency: lean prompts, regression rerun, and long-session evidence

2026-09-08. Follow-up to the [initial short evaluation](context-evaluation-2026-09-08.md), not a replacement for its results. User authorized token-efficiency changes, another short regression evaluation, and read-only inspection of Pi sessions on a private remote host. Publication copy: private host/session identifiers have been replaced with report-local labels. Mode descriptions below are historical; see the [current interface](../extensions/context/README.md).

## Changes in 0.2.1

1. Consolidated model-facing instructions in [guidance.ts](../extensions/context/guidance.ts). Removed repeated API explanations from the system guide, bootstrap and continuation. The four always-on guidance/description strings total **2,009 characters**; a regression budget prevents accidental expansion. This character count excludes tool JSON schemas and is not a tokenizer measurement.
2. Evidence markers shrink from **90 to 19 characters** for an eight-character ID: `[evidence:abc12345]`. The system guide retains the historical-data/not-authorization warning. Persisted messages, assistant reasoning and signatures remain untouched.
3. Targeted recall responses and continuation pages no longer repeat the full note index. First-page unfiltered discovery and explicit `source:'notes'` listing still provide it. Omitted `notes` is not `notes:[]`; matching notes remain in search results, and exact reads/pagination retain the original text and metadata.
4. Checkpoint guidance asks for operational state, outstanding requests, hard constraints, latest steering, progress/failures and next actions—not transcript narration. Detailed findings belong in linked notes. No new hard length limit, evidence deletion, reset-frequency change, or weakened persistence/branch/cancellation check.

Sources: [retrieval/bootstrap](../extensions/context/model.ts), [provenance](../extensions/context/provenance.ts), [README](../extensions/context/README.md), [regressions](../extensions/context/tests/lean.test.ts).

## Short-task regression rerun

Same nine cells, synthetic histories, staging prompts, model, thinking level and budgets as the initial evaluation: `xai/grok-4.5`, existing **OAuth subscription only**, no API-key fallback, two transitions per task. New results were written separately; previous results were not overwritten. No private remote-session content was included in model requests.

[Recorded results and answers](context-eval-2026-09-08-lean.json) · [runner](../extensions/context/evals/run.ts)

| Strategy, three tasks each | Fully correct scenarios, before → after | Input tokens, before → after | Output tokens, before → after | Calls, before → after |
| -------------------------- | --------------------------------------: | ---------------------------: | ----------------------------: | --------------------: |
| Stock                      |                               1/3 → 1/3 |              32,773 → 32,658 |                 3,628 → 3,564 |               18 → 18 |
| Stock + recall/notes       |                               3/3 → 3/3 |              94,364 → 65,403 |                 6,341 → 4,778 |               30 → 24 |
| Fresh + recall/notes       |                               3/3 → 3/3 |              50,963 → 47,005 |                 2,114 → 2,041 |               17 → 17 |

**No observed fact-recovery regression.** Both extension arms retained the original constraints/rejected design, exact failed test/values, and latest worktree/permissions. Stock again lost the buried rejected design and failure details. All 18 transitions completed; six used the fresh hook. No provider or extension errors. Total for this additional batch: **59 model calls, 295.3 seconds**, no retries of task runs.

- Fresh input decreased **7.8%**, with unchanged model-call and recall-call counts. This is consistent with reduced fixed overhead, but generated checkpoint prose also varies between trials.
- Stock+recall input decreased **30.7%**, but behavior changed too: fewer recall/notes calls. Do not attribute that entire reduction to shorter prompts. In this batch it used one named write and three checkpoint calls; the fresh arm again used six checkpoint calls and no named writes.
- Cache-read input: stock 7,936; stock+recall 19,328; fresh 17,024. Uncached-plus-cache-write input (total minus cache reads): 24,722; 46,075; 29,981. These are provider token counts, not dollar/subscription billing estimates.
- Elapsed time **increased** in every arm: stock 75.8→93.4s, stock+recall 126.7→147.5s, fresh 49.2→54.3s. Token reductions did not establish a latency improvement in these sequential trials.
- Still only one trial per cell before and after, shared provider caches, fixed ordering, short synthetic tasks and explicit transitions. This is a regression check, **not long-session effectiveness or universal savings evidence**.

### What “lossless” was actually checked

- The paid-run recorder compared the seeded original entries and their readable evidence text before/after each task: **unchanged in all nine tasks**. These were in-memory comparisons; the JSON names explicitly reflect that, not a disk-audit claim.
- Offline regression reconstructs a long Unicode/mixed-newline tool result through 997-character recall chunks after **two fresh bootstraps and reopening the persisted session**, then compares bytes. It also verifies exact note text, pointers, all checkpoint fields and absence of the original log in active context.
- Another regression fills all 64 note slots, omits the index from targeted responses, discovers the complete index explicitly, paginates every matching note, reads all references, and verifies no original entry was mutated.
- Existing tests continue to cover ambiguous markers, private reasoning/image exclusions, archive corruption, stale checkpoints, branch isolation, latest steering, cancellation, fallback and real-Pi continuation.

This protects **recorded textual evidence and tested recovery paths**. It does not make model-written notes/checkpoints semantically lossless, recover tool bytes never recorded by Pi, or prove every future answer will retrieve the right evidence.

### Telemetry edge case found during review

One fresh diagnostic sample reported 3,220 input tokens after the next staging checkpoint rather than alongside the immediate continuation. Reviewing that anomaly exposed a deterministic bug: the timestamp guard rejected a genuine post-compaction response when its timestamp equaled the compaction's millisecond. The focused regression failed (`undefined !== 123`) before the fix and passed afterward. Persisted branch order now establishes causality when timestamps tie or move backwards, while pre-boundary turns remain excluded.

The paid-run sessions had already been removed, so the exact cause of that individual sample cannot be confirmed retrospectively. Its recorded metric is left unchanged, and no corrected per-reset savings claim is made from it. Aggregate provider usage above is collected independently from response streams and is unaffected by this diagnostic-attribution issue. The fix was validated offline, not by additional paid reruns. [Regression](../extensions/context/tests/improvements.test.ts) · [implementation](../extensions/context/index.ts).

## Read-only long-session evidence from the remote host

Inventory at **08:04:48 UTC**, default `~/.pi/agent/sessions` store, using Python over authenticated SSH. No remote files/configuration/credentials were modified. Only aggregate metadata and temporary hashed labels were returned locally; the publication copy uses unrelated report-local labels instead. No transcripts were sent to the evaluation provider.

- **93 session files**, 134,394,655 bytes, 27,038 messages, 11,255 assistant responses; no malformed JSON lines at the inventory snapshot.
- Models in recorded assistant messages: 8,784 `gpt-5.6-sol`, 327 `grok-4.6`, 2,144 `gpt-6-astra`. These are counts of persisted messages, not independent tasks.
- **59 compactions: eight context fresh resets and 51 others.** All eight fresh resets are in Astra sessions. No `context.event` diagnostics were found; absence does not establish historical activation/fallback rates.
- A genuinely long example, session B6: latest recorded leaf ancestry contains **7,394 messages, 3,576 assistant responses and 22 ordinary compactions**. Its recorded input sum is 514,466,077 tokens, of which 507,578,368 are cache reads. This confirms a workload very different from the short regression tasks; it is not a matched comparison with fresh mode.

A second pass reconstructed ancestry around all eight fresh compactions. Every checkpoint and reference was on the branch, the kept boundary matched its `context.window`, no prior message tail followed that boundary, and each compaction had one direct continuation plus a subsequent successful response.

| Session label | Pi tokensBefore | Next successful request input |
| ------------- | --------------: | ----------------------------: |
| B1            |          82,047 |                         6,563 |
| B1            |          84,150 |                         6,532 |
| B2            |         141,160 |                         6,627 |
| B3            |          89,819 |                         6,124 |
| B4            |         129,013 |                         5,566 |
| B4            |         166,668 |                         6,045 |
| B5            |         200,883 |                         5,878 |
| B5            |          45,598 |                         5,850 |

These are different accounting surfaces (Pi's before estimate versus provider-reported input/cache usage), **not controlled savings percentages**. They do demonstrate the intended small-active-window mechanics in real sessions.

There were **27 recall calls**. Of 26 parseable successful JSON receipts, **16 returned earlier-window evidence**, totaling 53 earlier-window result references; none referenced entries outside their active ancestry. The remaining receipt was an error indicating cursor/query validation, not evidence loss. This pass checked provenance/branch positions, not complete byte-for-byte replay or semantic correctness of every result.

Ten checkpoint calls supplied prose of **1,900–5,842 characters**; seven omitted manual references. There were three named writes, one append and two deletes. These are operation counts, not proof of useful daily note adoption; they may include workflow testing. No identical complete recall-argument repeats were found, but different queries can still revisit the same fact.

### Implications for token efficiency

1. **Small active windows are already demonstrated in the long-session workload.** Whether they prevent mistakes/context distraction or improve completed-work efficiency still needs task-level review; the inventory cannot answer that.
2. **Separate cached and uncached input.** Across all inventoried files, about 97.8% of summed input was cache-read tokens. Those sums can include shared/forked history and are not billed usage. Repeated cached history still affects prompt size, but should not be treated as equivalent to new input for billing/latency.
3. **Checkpoint prose is a larger remaining lever than marker syntax.** Keep hard constraints and next actions explicit while avoiding repeated detailed narration. The lean guidance encourages this without forcing a lossy summary size.
4. **Do not force more notes or recall calls merely to increase adoption.** The archive shows working historical recovery and low exact-query repetition. Instrument meaningful note use and recovered mistakes before prescribing extra tool turns.
5. No reset-threshold change is justified by this inventory alone. Preserve the safe workflow and use future daily sessions to assess repeated work, source recovery, active-window size and actual task outcomes.

### Scope and evidence

The inventory reads live files; counts can grow. General counts are file-order totals and may include branches/shared histories. The long-example and fresh/reset/recall checks explicitly reconstruct parent-ID ancestry. Only the default remote store was inspected. This is not an audit of all custom stores, deleted sessions, failed actions or user intent.

Local scratch evidence (aggregate-only): `/tmp/pi-box-context-metadata.json`, `/tmp/pi-box-context-branch-checks.json`. Published session labels B1–B6 are arbitrary and do not encode private paths or identifiers. Original evidence remains on the private audit host; the scripts ran read-only and were not installed there. Earlier local-store audit: [context-session-audit-2026-09-08.md](context-session-audit-2026-09-08.md).

## Mode controls follow-up (0.3.0)

At revision 0.3.0, the runtime exposed three strategies under the user's chosen names (superseded by the two-mode [0.4.0 follow-up](context-checkpoint-improvements-2026-09-08.md)):

| Command            | Behavior                                                   | Historical evaluation label |
| ------------------ | ---------------------------------------------------------- | --------------------------- |
| `/context default` | Ordinary Pi compaction, no memory schemas/guidance/markers | `stock`                     |
| `/context exp-1`   | Ordinary Pi compaction plus recall/notes                   | `stock-recall`              |
| `/context exp-2`   | Fresh windows plus recall/notes, with safe Pi fallback     | `fresh`                     |

New/missing preferences select `default`. Legacy `enabled:true/false` preferences retain their semantics as `exp-2/exp-1`, without an automatic rewrite. Tool availability changes when idle; mode switching preserves original history, notes and other tools. Diagnostics now identify the selected mode. The runner uses the new names for future batches; prior result files retain their original labels and measurements. No additional paid batch was run for this mode-control change.

Offline real-Pi tests verify provider-visible tools and guidance in all modes, stock compaction in default/exp-1, fresh-reset behavior in exp-2, and switching between prompts without reload. Additional tests cover migration, corrupt preferences, idle synchronization, stale in-flight memory calls, notes retained across switches and shutdown cleanup. See [mode tests](../extensions/context/tests/modes.test.ts) and [README](../extensions/context/README.md).

## Validation / reproduce

```bash
bun run --filter pi-context check
# Explicit subscription use; choose a new result path.
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-next.json
```

Checks at revision 0.3.0 (including mode controls): formatting, lint, typecheck and **72 tests passed**. All workspace checks plus root lint/typecheck/skill tests passed: **214 tests passed, one optional live-MCP test skipped**. `git diff --check` passed. The initial root formatting gate flagged the original audit report; its publication copy was subsequently redacted and formatted before commit. The paid evaluation is opt-in; normal checks never call the provider. This work did not deploy changes to the private audit host.
