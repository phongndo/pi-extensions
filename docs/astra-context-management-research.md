# Astra context management: compression and suitability for a pi extension

Research date: 2026-09-07 (local clock). **Implementation follow-up:** [`extensions/context/`](../extensions/context/README.md) now implements local notes, read-only `recall`, budget reminders, and verified fresh-window resets. The user explicitly chose **resets on by default**, with global `/context on|off|status`. Offline tests cover the real Pi 0.85.1 lifecycle; no authenticated provider probes or paid model evaluations were performed.

Sources: OpenAI product/API documentation; public Codex source pinned at `e7637306bc9246a3e42e407cb94f96b7ed345e3e`; pi source tagged `v0.85.1` (`d981de1229ef899957bbe968bc8dcda02a21f477`); installed pi documentation; ARC Prize's own benchmark report. Codex `main` is moving and the inspected commit reports a 2026-09-08 date: implementation details below describe that snapshot, not a verified match to every released client.

## Recommendation

**Original research recommendation:** build a staged, opt-in, provider-neutral extension and retain normal Pi compaction as fallback. **User-selected implementation:** build the full notes → checkpoint → fresh-window workflow now, enabled by default. Normal compaction remains the safety fallback; no private Codex backend is used. Default-on is a product preference, not a claim of demonstrated cross-model quality.

The useful idea is to separate:

1. **Working context:** a bounded checkpoint; the implemented fresh reset retains no earlier conversation tail.
2. **Durable notes:** accumulated findings, decisions, unsuccessful approaches, and outstanding work.
3. **Evidence:** original recorded messages and tool results, addressable and searchable after compaction.

That makes omissions recoverable instead of requiring every future-relevant detail to survive successive summaries. It does **not** make model-written notes lossless, guarantee the model will retrieve the right evidence, or establish lower total cost. Those need evaluation.

Pi already preserves session history and exposes the tools, state, and compaction hooks needed for a useful first version. The biggest work is reliable state transitions and retrieval behavior, not a new compression algorithm. [P1][P2][P3]

## Fidelity to Codex: verified against the implementation

**The implementation follows Codex's core notes/history/fresh-window behavior, with intentional local safeguards.** The HTML walkthrough illustrates the implemented checkpoint/reset/retrieval sequence. Codex's tests were inspected, not executed; our offline tests exercise the actual Pi loader, requested and threshold resets, continuation, and overflow fallback.

| Concern            | Codex experiment                                                                                                | Implemented `context/` extension                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Retrieval          | Separate `history` list/search/read operations; literal search and bounded reads                                | One read-only `recall` tool with search, exact reads, recent listing, and current note index                 |
| Evidence IDs       | Agent + window + item identity                                                                                  | Session/branch-scoped pi entry IDs; references must remain resolvable across compaction and forks            |
| Notes              | Agent-written incremental notes are part of the rollover workflow                                               | Separate `notes` tool with branch-local revisions and structured checkpoints                                 |
| Context transition | Fresh initial context, no generated conversation summary; previous user/assistant messages leave active context | Verified checkpoint + note pointers; no earlier conversation tail and no generated summary on the fresh path |
| Storage            | Authenticated Codex backend; encrypted fields/output and eventual-consistency semantics                         | Local Pi session JSONL; ancestry-scoped scans, no external backend                                           |
| Reset precondition | `new_context` handler requests a transition without itself checking a successful notes write                    | Verifies checkpoint freshness and all persisted branch evidence; otherwise stock compaction                  |

Sources: tool definitions [C6], catalog guidance [C1], reset implementation [C4][C5][C9], backend [C7], and tests asserting no compact-endpoint call and removal of prior user/assistant messages [C10].

The implemented sequence is: incremental notes with evidence IDs → budget reminder → validated checkpoint → fresh window without a generated summary → read notes and use `recall` for missing evidence. This selects variant D below. Local storage, consolidated retrieval, structural/persistence validation, and stock-compaction fallback remain intentional differences. A solo checkpoint tool terminates its batch; requested transitions occur at `agent_settled`, not reentrantly inside the tool. Pi's `summary` field carries a deterministic bootstrap, and a non-message `firstKeptEntryId` boundary retains no earlier messages.

## 1. Which OpenAI system is this?

Three features are easy to conflate:

| Feature                                             | What persists                                                        | Mechanism                                                         | Portability                                                |
| --------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| **New Astra/Codex experimental context management** | Notes and searchable history from the same task                      | Agent writes checkpoints; harness opens fresh context windows     | Architecture is portable; native service is Codex-specific |
| **Responses API compaction**                        | An opaque encrypted compaction item, potentially with retained items | Server-side threshold compaction or explicit `/responses/compact` | Provider/protocol-specific                                 |
| **Codex local memories**                            | Useful information from eligible prior chats                         | Background extraction and consolidation into local memory files   | Separate cross-chat feature                                |

The Astra announcement explicitly describes notes across context windows and searchable earlier messages/tool outputs. The product documentation says it is off by default, requires a supported client and eligible ChatGPT sign-in, and is unavailable with Business, Enterprise, or API-key sign-in at launch. [O1][O2]

Documented Codex opt-in, **not a pi setting**:

```toml
[features.context_management]
experimental_mode = true
```

Start a new task after enabling it. The models page names Plus/Pro; the config reference and inspected eligibility code also include Pro Lite. Code additionally checks model capability (`supports_experimental_context`), provider route/auth compatibility, and feature policy. Selecting Astra in pi alone does not install this Codex subsystem. [O2][O3][C2]

Local Codex memories are independently enabled through `features.memories` and generated from idle eligible chats; they are not the notes store discussed below. [O5]

## 2. How the new system actually compresses context

### It replaces recursive summary compression with selective preservation and retrieval

```text
Current window: user requests + model outputs + tool results
       │
       ├── agent writes/updates concise notes with source references
       │
       └── recorded history remains available through history tools

Budget reminder → checkpoint write → new_context
                                        │
                                        ▼
                         fresh initial context + window identity/hint
                                        │
                          read notes; retrieve missing evidence
                                        │
                                        ▼
                                continue the same task
```

The inspected `compact_token_budget.rs` explicitly says token-budget compaction **skips model/server summarization** and installs a fresh context window. Both manual and automatic paths still emit normal compaction lifecycle events. [C5]

`start_new_context_window()` reconstructs initial context, advances window identity, replaces active conversation history, and records an empty summary string. There is conditional retention of client-authored developer messages. A test explicitly asserts that earlier user/assistant messages disappear from the next request and that the server compact endpoint was not called. This is a context transition within the task; it does not reset the workspace/environment. [C4][C9][C10]

**Compression still happens semantically:** the model decides what to preserve as concise notes. But notes do not have to be repeatedly folded into one replacement summary, and omitted details can be recovered from history. The raw archive can grow while the active prompt stays bounded. The public client does not establish a new learned codec, embedding-based retrieval scheme, or lossless semantic compression algorithm. [O1][C1][C6]

### Checkpoint contents and token-budget behavior

The bundled Astra guidance asks the model to preserve:

- Goal and active user requests.
- Decisions, progress, learnings, and next steps.
- Window IDs and item IDs for relevant user requests and important actions/tool results.
- Incremental notes during work, with obsolete information cleaned up when appropriate.

After reset, the model is directed to read its checkpoint and recover missing details. Known IDs should go directly to `read_item`; otherwise use listing or search. This preference matters: direct evidence lookup avoids replaying a large transcript. [C1]

Inspected bundled Astra settings:

| Setting                   | Value/behavior                                             |
| ------------------------- | ---------------------------------------------------------- |
| Reminder threshold        | 6,144 remaining tokens                                     |
| Emergency fallback buffer | 16,384 tokens                                              |
| Near-limit instruction    | Save notes, then call `new_context`                        |
| Base budget exhausted     | Request exactly one notes write/append, then `new_context` |
| Forced rollover           | Buffered budget or full effective context limit reached    |

These are **catalog defaults in the inspected source**, not universal recommended pi settings. The remaining budget can count the whole active context or the body after the initial prefix. The emergency buffer extends the soft auto-compaction threshold; it cannot extend the model's hard context limit. Reminders/fallback prompts are claimed once per window. [C1][C2][C3]

The emergency instruction is not equivalent to a runtime tool allowlist: the inspected test asserts that the normal tool surface remains available. More importantly, the `new_context` handler simply requests a transition; **it does not itself check that notes were successfully saved**. [C9][C10]

### Notes and history tools

The native extension exposes nine operations: [C6]

| Namespace | Operations                                                                             | Important semantics                                            |
| --------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `history` | `list_windows`, `list_items`, `read_item`, `search_contents`                           | Read-only, opaque IDs, role/tool/window filters, bounded reads |
| `notes`   | `list_files_by_prefix`, `read_file`, `search_contents`, `append_to_file`, `write_file` | Virtual paths, append/replace writes, line-range reads         |

Search is documented in the tool schemas as **case-sensitive literal substring search**. A vector database is not required to reproduce the exposed behavior. Note files have a documented 1,000,000 UTF-8-byte limit; that is a storage limit, not an instruction to load whole files into the prompt. [C6]

The tool contract describes immediate read-after-successful-write consistency for notes, but eventual consistency for history and note listing/search. A separate `thread_hint` request supplies a bounded context-window hint; the client rejects hints exceeding 4,000 bytes. Test fixtures show a recent-note listing, not automatic insertion of every note's contents. [C6][C8][C11]

### What cannot simply be copied into pi

These tools call authenticated Codex backend routes such as:

```text
alpha/history/v2/read_item
alpha/history/v2/search_contents
alpha/notes/v2/write_file
alpha/notes/v2/thread_hint
```

Calls carry session and agent identity. Search queries and note-write text are marked for encrypted argument handling, and outputs can contain opaque encrypted content and separate images. The extension is gated to an appropriate OpenAI/Codex backend authentication path. These are not documented general-purpose Responses API endpoints. [C6][C7][C8]

Therefore, copying the HTTP wrappers would not produce a general pi extension. It would depend on backend eligibility, server-side history population, identity conventions, and provider-specific encrypted content. The public client also does not reveal all server storage, indexing, encryption, or retention internals.

A pi version should manage its own **task-state notes and recorded evidence**, rather than try to extract or reproduce private model reasoning.

## 3. How this differs from ordinary Responses compaction

OpenAI's public API separately supports: [O4]

- `context_management: [{ type: "compaction", compact_threshold: ... }]` on Responses requests. The server emits an encrypted compaction item and continues with reduced context.
- An explicit `/responses/compact` request returning the canonical next context window. The input must still fit the model's window. Its output may contain retained items as well as the compaction item and should be passed onward as-is.

For stateless server-side chaining, the guide permits dropping items before the latest compaction item. That pruning rule must **not** be applied indiscriminately to standalone compact output, or to `previous_response_id` chaining. [O4]

**Adding `context_management` to pi's outgoing JSON is not sufficient support.** Pi also needs to capture, persist, replay, and account for the returned opaque items. In the inspected pi `v0.85.1` Responses converter/parser and common message types, there is no compaction-item handling. The response hook exposes status/headers, not the raw streamed body. Native API compaction is thus a separate provider-integration project, not the implementation of this portable notes/history extension. [P1][P4]

## 4. Is it actually better?

### Why the architecture is promising

These are engineering assessments, not measured results:

- **Recoverable omissions:** a forgotten failure detail can be looked up instead of rerunning the failed approach.
- **Less cumulative rewriting:** stable findings can retain their original records and references across many windows.
- **Targeted recall:** bounded exact reads can be much cheaper than reopening entire logs or redoing web research.
- **Model portability:** task-state text and local evidence are usable by different tool-capable models.
- **Inspectability:** a local implementation can show exactly which checkpoint and evidence were used.

Pi makes a particularly good starting point: it already saves older messages instead of deleting them. Its default summarizer also truncates each serialized tool result to 2,000 characters, so searchable original recorded results could recover details that never entered the summary. The archive still cannot recover data a tool never returned or permanently truncated before persistence. [P2][P3][P5]

### Costs and failure modes

- Writing, reading, and searching notes adds model turns and tool-output tokens. Short sessions may only get slower.
- A model may forget to write notes, write an incorrect checkpoint, or fail to realize it needs retrieval.
- Notes can become stale or contradictory. Source references, revision provenance, and supersession matter.
- Re-reading everything after each reset defeats the intended savings.
- A reset invalidates some prompt-cache reuse. Smaller active context does not automatically mean a cheaper completed task.
- Retrieval can revive hostile instructions from earlier external content. Quoted evidence must not become developer-level authority.
- Shared note files can leak across branches or contaminate concurrent sessions.
- Provider-specific reasoning continuity may carry value that visible task notes cannot replace.

There are public reports of missing notes/history tools and backend 404s followed by context reset. These are **reporter observations, not independently reproduced failures or population-level reliability estimates**. One report discloses a custom model catalog and no unmodified-catalog control. They nevertheless identify useful failure cases to test, and the lack of a checkpoint check in the reset handler is directly observable in source. [I1][I2][C9]

### Evidence limits, including ARC-AGI

I found **no isolated public comparison in the reviewed sources** measuring the new Codex notes/history experiment against pi-style compaction, with the same model and coding tasks. Astra's overall coding benchmark improvements cannot be attributed to this feature. [O1]

ARC Prize supplies relevant but different evidence: at `high` reasoning, its Standard harness scored Astra at **54.8%**, versus **99.9%** with its Provider Adapter. The adapter preserves opaque reasoning state and uses compaction; the Standard harness relies on visible carried notes. This is **not a test of the new Codex notes/history system**, nor an isolated compression ablation. It is a strong reason to avoid assuming that visible notes universally replace provider-native state without quality loss. [E1]

**Assessment:** high confidence in extension feasibility; plausible quality benefits for long, tool-heavy sessions; unproven general cost/latency improvement; insufficient evidence to make summary-free reset the default.

## 5. Original staged implementation proposal

This section preserves the original research proposal. The user subsequently selected the full fresh-window variant described above; see the [extension README](../extensions/context/README.md) for current behavior, safeguards and limitations.

**User-selected names:** extension **`context`**, directory **`extensions/context/`**, model-callable retrieval tool **`recall`**. Note writing is implemented separately as **`notes`**.

### Phase 1: add recall without replacing compaction

Expose one provider-neutral, read-only tool: **`recall`**.

```ts
recall({ query: "First fix", limit: 5 });
// Search recorded history; return bounded snippets and source entry IDs.

recall({ entryId: "abc123", offset: 0, limit: 4000 });
// Read a bounded character range from one recorded item.
```

Search limits count results; read limits count characters. Notes become searchable when introduced in phase 2. Note writing is a separate later capability, not a write/reset mode on `recall`. Budget/status reporting can live in extension UI rather than expanding the v1 tool surface.

Use the existing session JSONL as the source of truth. Build a rebuildable local search index only if scanning becomes measurably slow. Start with literal search and exact-ID reads; add ranked lexical search if evaluations expose discoverability problems. No hosted service or embeddings are required initially.

Persist versioned note revisions through `pi.appendEntry()` or tool-result `details`. Reconstruct notes from `ctx.sessionManager.getBranch()`, not unrestricted `getEntries()`: the latter includes sibling branches. Custom entries survive compaction without automatically entering the model prompt. Restore state on session start/reload and tree navigation; deliberately handle forks. [P1][P2]

Keep default pi compaction unchanged. Give its continuation enough stable guidance to use recall when information is missing. This isolates the value of retrieval before changing the reset policy.

### Phase 2: checkpoint-based compaction with a recent tail

Use `session_before_compact` to produce:

```text
current system instructions
+ small active-task checkpoint
+ note/evidence references
+ recent intact messages
```

Use incremental per-window notes, not another ever-growing summary of all previous notes. Keep important current constraints and the latest steering in the bootstrap itself; a bare "go read your notes" pointer is too fragile. Retain recent tool-call/result groups and use pi's prepared `firstKeptEntryId` initially. [P3]

A useful checkpoint contains:

```text
Goal and outstanding user requests
Current constraints / authorization boundaries
Completed work, with evidence references
Failed approaches and why they failed
Current workspace revision / relevant file state
Unresolved questions and next action
Source-entry coverage and note revision
```

Suggested hooks and responsibilities: [P1][P2][P3]

| pi surface                                          | Responsibility                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `registerTool`                                      | Note mutation and bounded recall                                                       |
| `appendEntry`, tool-result `details`                | Durable note revisions with branch ancestry                                            |
| `session_start`, `session_tree`, `session_shutdown` | Restore branch state; clear stale caches/resources                                     |
| `getBranch`, `getEntry`                             | Original evidence lookup, with explicit ancestry checks                                |
| `getContextUsage`, `turn_end`                       | Budget observation and proactive checkpoint reminders                                  |
| `session_before_compact`                            | Validate checkpoint, select/retain safe tail, return summary + metadata                |
| `session_compact`, `session_compact_failed`         | Commit/result telemetry and recovery                                                   |
| `context`                                           | Optional non-destructive context presentation; not the sole compaction state mechanism |

Do not call `ctx.compact()` reentrantly inside an executing notes/reset tool. Initially let pi own automatic transitions. An agent-requested reset, if added later, should request work for a verified safe boundary after tool completion. Do not implement rollover with `/new`: it has different session and extension lifecycle semantics. [P1][P3]

### Required safeguards

1. **Checkpoint before eviction.** Persist and validate the checkpoint and evidence references before returning replacement compaction content. Record the covered source boundary; do not mistake "some old note exists" for coverage of the latest steering.
2. **Safe fallback.** If custom checkpoint generation fails, leave default compaction available. If no safe replacement can be formed, explicitly cancel and surface the failure rather than return an empty replacement. Throwing alone is not a cancellation: pi catches extension handler errors. [P6]
3. **One compaction owner.** Multiple `session_before_compact` handlers do not merge summaries; later results can replace earlier ones, while cancellation stops processing. Detect or document conflicts. [P6]
4. **Correct branch isolation.** Restrict both search and direct-ID reads to allowed ancestry. Notes from another branch/session require an explicit import, not accidental cache reuse.
5. **Bounded, provenance-preserving retrieval.** Return source role, entry ID, time/order, tool name, truncation status, and a continuation cursor. Never turn historical external instructions into current authoritative instructions.
6. **Cache stability.** Avoid rewriting the system prompt with changing note contents every turn. Publish a stable checkpoint at compaction boundaries and retrieve detailed notes on demand.
7. **Crash/reload semantics.** Persist note state with the session; make search indexes rebuildable. If large external artifacts are introduced, ensure copies/forks/deletion have defined behavior and no dangling temporary-file references.
8. **Preserve provider state where supported.** Do not mutate signed/opaque reasoning blocks to attach search IDs. Portable task notes complement native reasoning continuity rather than claiming to reproduce it.

### Version compatibility found during research

At research time the manifest requested pi `^0.85.1`, but root `node_modules` resolved **0.82.1**. Implementation refreshed the workspace installation and uses **0.85.1** for the context extension and real-host tests. Existing extension dependency pins were not changed.

Also, the installed session-format documentation mentions newer `retainedTail` checkpoints, while the inspected tagged `v0.85.1` source uses `firstKeptEntryId`. Build against the actual supported API; do not assume the newer checkpoint shape is available. [P2][P3]

## 6. Evaluation before making it a general default

Run a controlled comparison, not just a "tokens after compression" demo.

### Variants

| Variant                                                  | Purpose                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| A: stock pi compaction                                   | Baseline                                                                  |
| B: stock pi + notes/history retrieval                    | Isolate retrieval value                                                   |
| C: checkpoint-based compaction + recent tail + retrieval | Test the recommended replacement policy                                   |
| D: summary-free reset + notes/history                    | Implemented by user choice; cross-model quality still requires evaluation |

Hold model, reasoning level, tool budgets, starting checkout, and cache/transport conditions fixed within each comparison. Test Astra plus at least one other provider's strong tool-capable model and a cheaper model; infrastructure portability is not proof of equal model behavior.

### Test cases

- Long debugging with multiple failed hypotheses; require recall of the failure reason after several transitions.
- Refactor with early constraints, a side question, then late corrective steering.
- An exact error code or test result outside the default summary serializer's first 2,000 tool-result characters.
- Contradictory evidence across revisions; old passing tests must not imply the current tree passes.
- Parallel tool completion, cancellation, oversized output, and overflow recovery.
- Resume, fork, tree navigation, and model switch; check for sibling-branch contamination.
- Missing, stale, corrupt, or failed checkpoint writes; reset must not silently erase working state.
- Retrieved prompt-injection text; it must remain evidence rather than gain authority.

Replay tests can measure reference resolution and state integrity without model calls. Use live end-to-end continuations to measure whether the model actually writes useful notes and retrieves needed facts. Force multiple compactions in smaller-window tests, then confirm findings at realistic thresholds. Run in disposable workspaces so repeated writes/external actions do not contaminate comparisons.

### Metrics and adoption gate

Measure task/test success, exact constraint recall, repeated failed actions, retrieval accuracy, retries, total tokens including checkpoint generation and retrieved output, cached versus uncached input, actual available billing/credit data, and median/p95 wall-clock time. Track each transition's before/after active context size separately from total session cost.

Agree the acceptable quality-regression margin and budget before paid evaluation. Adopt C only if repeated trials show task quality is preserved or improved and total cost or latency improves on the intended workload. Keep B as a useful standalone extension if retrieval helps but replacement compaction does not. Keep D experimental until it independently earns promotion.

## Sources

### OpenAI product and API documentation

[O1]: https://openai.com/index/gpt-6-astra
[O2]: https://learn.chatgpt.com/docs/models?surface=app#experimental-context-management
[O3]: https://learn.chatgpt.com/docs/config-file/config-reference
[O4]: https://developers.openai.com/api/docs/guides/compaction
[O5]: https://learn.chatgpt.com/docs/customization/memories

### Codex implementation — pinned inspected snapshot

[C1]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/models-manager/models.json#L104-L112
[C2]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/src/session/token_budget.rs
[C3]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/src/session/context_window.rs
[C4]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/src/session/mod.rs#L4224-L4276
[C5]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/src/compact_token_budget.rs
[C6]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/ext/history-notes/src/tools.rs
[C7]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/ext/history-notes/src/backend.rs
[C8]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/ext/history-notes/src/extension.rs
[C9]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/src/tools/handlers/new_context_window.rs
[C10]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/core/tests/suite/token_budget.rs
[C11]: https://github.com/openai/codex/blob/e7637306bc9246a3e42e407cb94f96b7ed345e3e/codex-rs/ext/history-notes/tests/history_notes_extension.rs

### pi documentation and implementation

[P1]: /home/z/.local/share/mise/installs/pi/0.85.1/pi/docs/extensions.md
[P2]: https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/session-manager.ts
[P3]: https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/compaction.ts
[P4]: https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/api/openai-responses-shared.ts
[P5]: https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/utils.ts
[P6]: https://github.com/earendil-works/pi-mono/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/runner.ts

### Evaluation and rollout reports

[E1]: https://arcprize.org/blog/astra
[I1]: https://github.com/openai/codex/issues/42449
[I2]: https://github.com/openai/codex/issues/43194
