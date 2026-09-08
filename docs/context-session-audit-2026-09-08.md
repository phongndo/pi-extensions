# Context extension: session audit and lessons

Audit: 2026-09-08. Inventory completed at 07:17:45 UTC. Extension source at repository HEAD `4e22f72`; the audit changed no extension code or settings. Publication copy: private session paths, record identifiers and precise session-event times are replaced with local labels; findings and aggregate measurements are unchanged.

## Verdict

**The observed reset and retrieval mechanics work as documented. The full incremental-notes workflow is not yet demonstrated in real usage.** Four real resets preserved their archives, installed checkpoint-only context, and continued automatically. Historical recall demonstrably recovered pre-reset evidence. However, there were no named note writes and no manually supplied checkpoint evidence references in the audited sessions. This is currently being used more like **checkpoint replacement plus searchable history** than accumulated, evidence-linked working notes.

This is not proof of Astra-equivalent quality, lossless memory, or cheaper completed tasks.

## Scope and method

- Parsed every JSONL file under `~/.pi/agent/sessions/`: **2,836 files**, **108 immediate directories**, approximately **2.57 GB**, **325,198 message entries**. Session-header timestamps span June 26–September 8, 2026. No malformed JSON lines found.
- Inspected all persisted context-extension checkpoint/window/continuation entries, all `notes`/`recall` tool results, and all compaction metadata. Read the checkpoints and relevant recovery exchanges; did **not** manually judge every message in the archive.
- This covers the discovered default session store, not deleted/remote/ephemeral sessions or undiscovered custom `--session-dir` stores. Neither session-directory override environment variable was set. Some sessions were still live: counts describe the scan snapshot, not a frozen global transaction.
- Global settings load this repository as a package. `~/.pi/agent/context.json` was absent, which meant enabled by default at the audited revision. This does not prove historical extension activation in every session.
- Ran `bun run --filter pi-context check`: formatting, lint, typecheck, and **49 tests passed, 0 failed**. Tests include real Pi loading/lifecycle, multiple resets, continuation, fallback, archive corruption, steering/cancellation, and branch/revision behavior. [L1]
- A read-only replay imported the actual `model.ts` implementation and Pi's `buildSessionContext`. For all four real resets it asserted valid checkpoint coverage/references, exact deterministic bootstrap, checkpoint/window linkage, no earlier conversation tail, one continuation child, and a subsequent assistant response. Injected late-user-message negative controls were rejected. All five historical recall responses replayed identically against their original branch ancestry. No session files were written by the audit.
- Local scratch evidence: `/tmp/pi-context-session-audit.json`, `/tmp/pi-context-audit-replay.ts`, `/tmp/pi-context-replay-results.json`, `/tmp/pi-context-check.log`. Replay command: `bun /tmp/pi-context-audit-replay.ts`. These are temporary audit artifacts, not permanent fixtures; the replay currently embeds this checkout path.

## Production evidence

Only two saved sessions contained this extension's activity:

- **S1:** first private session containing observed context-extension activity.
- **S2:** second private session containing observed context-extension activity.

Session labels below are local to this report, not real identifiers or path hashes.

### Resets

All four ran with `gpt-6-astra` on the first subsequent assistant response.

| Session / reset label | Checkpoint label | Recorded tokens before | First subsequent request input* |
| --------------------- | ---------------- | ---------------------: | ------------------------------: |
| S1 / R1               | C1               |                240,552 |                           8,155 |
| S2 / R2               | C2               |                 68,774 |                           8,754 |
| S2 / R3               | C3               |                163,087 |                           8,584 |
| S2 / R4               | C4               |                 44,774 |                           8,876 |

\* Sum of persisted `usage.input + cacheRead + cacheWrite`. These are different measurement surfaces from Pi's `tokensBefore`, so use them as evidence of a small post-reset request, **not** a controlled savings percentage or billing result.

Each reset had a solo successful checkpoint call, an on-disk checkpoint, a `context.window` marker used as `firstKeptEntryId`, matching compaction metadata, and exactly one `context.continue` child. Rebuilt context at the compaction consisted of one `compactionSummary` carrying the deterministic bootstrap: no earlier user/assistant/tool tail. Bootstrap sizes were 2,927–6,566 characters. The extension supplies the bootstrap rather than requesting a generated conversation summary. [L2][L3]

The continuations were task-appropriate at the immediate step: S1 delivered the requested recreated-handoff path; S2 resumed inspection/work. Later checkpoints explicitly retained the user's switch to the normal worktree, preservation of inherited dirty work, one-browser constraint, and disposable-database-only migration permission. This is positive spot-check evidence, not exhaustive semantic verification.

There were **292 total compactions: 4 context-extension resets and 288 other compactions**. The latest non-context compaction preceded the first observed fresh reset. Historical compactions are not extension failures; activation and fallback reasons are not recorded well enough to use all 292 as a success-rate denominator.

### Retrieval actually crossed reset boundaries

All five recorded recall calls succeeded and reproduced exactly:

| Query/read       | Observation                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `docker exec`    | Returned three entries preceding the first S2 reset.                                                                  |
| Read evidence E1 | Recovered the original pre-reset assistant tool call containing the relevant Docker setup command.                    |
| `focused`        | Returned four matches, three of which were checkpoints/compaction bootstraps rather than original user/tool evidence. |
| `chrome`         | Returned six current-window matches, not the earlier user requirement.                                                |
| `one chrome`     | Recovered original user evidence E2 after two subsequent resets (R3 and R4).                                          |

Five S2 receipts were inspected; their private identifiers are withheld.

The final example is the strongest real demonstration of the intended benefit: an earlier requirement remained retrievable from its original message after multiple fresh windows. The search refinements also reveal avoidable retrieval friction.

### Missing part of the intended workflow

- **0 `context.note` entries**: no named incremental findings, decisions, or failed-approach notes.
- **4 checkpoints, each with exactly one reference:** the automatically attached latest user-message ID.
- All four checkpoint calls omitted `references`. No checkpoint explicitly linked a passing/failing test output, original investigation result, or relevant side-question answer.
- Checkpoint prose did include useful failures and constraints, but the harness only verifies structure, ancestry, freshness, and persistence. It cannot establish that the prose faithfully covers every request or correctly reports a test result. [L1][L3]

This does not invalidate the resets. It limits the stronger claim that durable, source-backed incremental notes are working in everyday use.

## Comparison with OpenAI's experiment

The supplied announcement explicitly describes notes across context windows plus searchable earlier messages/tool outputs, so information omitted from notes remains recoverable. It does not claim every old detail stays in the active prompt or that note-taking is semantically lossless. The product documentation describes the experiment as opt-in/off by default on supported clients, with launch eligibility restrictions. [O1][O2]

Your extension matches the central separation:

1. Small current working state: structured checkpoint/bootstrap.
2. Durable notes: branch-local revisioned custom entries, supported but unused in this sample.
3. Original evidence: archived messages/tool results accessible through `recall` after resets. [L1][L3]

OpenAI's pinned public history-tool definitions expose literal case-sensitive search, role/tool/window filters, bounded exact reads, and item IDs described as visible trailing markers on history items. Its note operations support incremental append/write. These are useful interface ideas; a vector database is not required. This is one pinned source snapshot, not verification of every deployed Codex client/backend. [O3]

Intentional differences worth keeping: local/provider-neutral storage, branch isolation, revision checks, persistence verification before eviction, and stock-compaction fallback. Selecting Astra in Pi does not activate Codex's backend history/notes subsystem. Cross-session search is **not** part of this extension's documented contract; this audit used filesystem access to inspect all sessions. [L1]

## What we should learn / prioritize

### 1. Make evidence-linked note-taking easy, not merely available

The largest observed gap is behavioral, not a broken reset state machine. Give the model a cheap way to obtain stable IDs for meaningful user/tool evidence while it works, then encourage a small named note after a confirmed failure, decision, or milestone. Carry outstanding work and constraints in the checkpoint; keep detailed findings in separately addressable notes.

Currently ordinary evidence IDs generally require a `recall` discovery call before they can be cited. OpenAI's history contract explicitly describes item-ID markers. Explore safe model-visible provenance without mutating signed/provider reasoning state or destabilizing the prompt prefix. Do not blindly require N references: that encourages irrelevant citations and can block a safe reset. Measure useful source coverage instead. [L2][L3][O3]

### 2. Improve targeted retrieval before adding embeddings

The actual `focused` search surfaced three derived summaries; `chrome` missed the older user instruction in its first page. Add a small number of optional filters to the existing `recall` interface—e.g. source role/tool, original evidence versus derived summaries, and before/current-window selection. Keep exact-ID reads and pagination. Preserve existing branch isolation.

OpenAI already exposes role/tool/window filtering. This is a directly evidenced improvement opportunity, unlike speculative semantic-search infrastructure. Do not hide summaries entirely: they can be useful when explicitly requested. [O3]

### 3. Persist transition observability

Record minimal structured activation/version and transition outcomes: requested, fresh-reset success, normal fallback with reason, cancelled, failed, resumed; checkpoint/window IDs; before/after context accounting. Avoid storing raw content or secrets in telemetry.

Today `session_before_compact` fallback reasons are UI notifications, not durable context audit entries, and budget reminders are injected into the outgoing context rather than persisted in session JSONL. We cannot reconstruct reminder delivery/compliance or historical fallback rates from saved sessions alone. A footer label means the mode is enabled, not that the previous transition used the fresh path. [L2]

### 4. Evaluate task quality, not just smaller windows

Turn the observed cases into sanitized evaluations: recover an earlier one-browser constraint after two resets; retrieve an exact failed-test reason omitted from a checkpoint; preserve a late worktree/permission change; avoid rerunning a completed action; reject sibling-branch evidence and retrieved hostile instructions.

Compare stock compaction, stock plus recall/notes, and fresh reset plus notes with the same model, task, and budgets. Score constraint retention, correct source retrieval, repeated failed actions, task/test success, total tokens/cache costs, and elapsed time. All observed production resets here used Astra, so this audit does not establish cross-model quality. Obtain a budget before paid trials.

**Recommendation:** keep the current safety checks and fallback. Prioritize provenance + incremental note behavior, then retrieval filtering and telemetry. Do not claim the full notes-based workflow or cost superiority until the task-level evaluations demonstrate it.

## Sources

[L1]: ../extensions/context/README.md
[L2]: ../extensions/context/index.ts
[L3]: ../extensions/context/model.ts
[O1]: https://openai.com/index/gpt-6-astra/
[O2]: https://learn.chatgpt.com/docs/models?surface=app#experimental-context-management
[O3]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/ext/history-notes/src/tools.rs

Earlier architectural research: [astra-context-management-research.md](astra-context-management-research.md). Session, reset, checkpoint and evidence labels above are anonymized; original records remain private. No transcripts were uploaded for this audit.
