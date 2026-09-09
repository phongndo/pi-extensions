# Context management: feasibility and improvement plan

Research date: 2026-09-08. Repository inspected at `641d179580b2346213b5e2c6676483617ee8e4eb`; context extension **0.6.0**, Pi **0.85.1**.

> Historical research snapshot, not the current runtime specification. Version 0.7.0 removes all context modes, `/context`, preference polling, notes writing and custom rollover. Recall is always registered alongside stock Pi compaction; the extension never changes the caller's active tools. See [README.md](README.md). Proposals below remain unimplemented; references to local code describe the pinned 0.6.0 revision above.

## Recommendation at the time of research

**Yes: improve the existing notes-and-search implementation rather than rebuild it.** The current `exp` mode already implements the essential architecture OpenAI describes for experimental Codex context management: durable notes, searchable earlier history, and fresh context windows without repeatedly summarizing previous summaries. This is distinct from OpenAI's encrypted Responses API compaction. [O1–O4]

The highest-value next work is:

1. Strengthen evaluations so they measure correct continuation, not merely preserved strings.
2. Test a small, bounded recovery packet containing selected original user text and current note contents, rather than only pointers.
3. Improve evidence retrieval while keeping exact-ID reads, branch isolation, and provenance.
4. Improve budget accounting and the host rollover interface.
5. Treat native OpenAI compaction as a separate, opt-in integration—not a prerequisite for better local memory.

These are proposals, not implemented runtime changes. This research does not establish that a revised policy outperforms stock Pi or the current `exp` mode. No paid model evaluations were run.

## 1. What OpenAI actually documents

| Claim                                                                  | Finding                                                                                                                                                                                                                                                                             | Consequence for this extension                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Compaction supports long-running tasks                                 | Confirmed. OpenAI describes reducing context while preserving state needed for subsequent turns, balancing quality, cost, and latency. [O1]                                                                                                                                         | A useful infrastructure feature, not a guarantee against every long-session failure.                                |
| `POST /responses/compact` exists                                       | Confirmed. It is stateless; the supplied window must still fit the model's context window. Its output is the canonical next window and must be passed on without pruning. [O1]                                                                                                      | Compact proactively; preserve the entire returned array, not just its encrypted item.                               |
| Server-side compaction exists                                          | Confirmed. Responses creation accepts `context_management: [{ type: "compaction", compact_threshold: ... }]`; the stream emits an encrypted compaction item. [O1]                                                                                                                   | Requires response parsing, persistence, and replay, not just a request flag.                                        |
| All prior user messages are always kept verbatim                       | **Not a safe universal contract in the current guide.** Standalone output can contain retained items, but the guide does not promise that every user message remains verbatim. Server-side input-array chaining even permits dropping items before the latest compaction item. [O1] | Keep our own original archive. Do not infer a retention policy from older examples or forum descriptions.           |
| The blob preserves a mathematical latent state or internal world model | The guide says it carries key prior state and reasoning, is opaque, and is not human-interpretable. It does not specify a public compression algorithm, fidelity guarantee, or world-model representation. [O1]                                                                     | We can consume the provider's representation; we cannot reproduce it by encrypting a text summary.                  |
| Astra/Codex uses running notes and searchable earlier windows          | Confirmed explicitly in OpenAI's Astra announcement. It describes retaining notes without repeatedly compressing them into one summary and finding requirements/test results in older messages and tool outputs. [O2]                                                               | This is the closest match to our current `exp` implementation.                                                      |
| This newer feature is the same public API as `/responses/compact`      | Not established. Codex documents a separate `features.context_management.experimental_mode` configuration with eligible ChatGPT sign-in. The inspected Codex source also checks provider routes and model capability. [O3, O4]                                                      | Do not assume ordinary API access or another provider grants access to Codex's hosted history/notes implementation. |
| Compaction eliminates context limits or context rot                    | Too strong. The standalone request still has a context limit; neither cited mechanism promises lossless understanding, perfect retrieval, or unlimited storage. [O1, O2]                                                                                                            | Describe the feature as bounded active context with durable, retrievable history.                                   |

### Follow-up: does experimental Codex still generate rollover summaries?

**No, in the activated experimental token-budget path inspected here.** Both automatic and manual compaction dispatch check `Feature::TokenBudget`, invoke `compact_token_budget`, and return before the normal remote/local summarization paths. [O5, O6]

The implementation explicitly documents:

> Token-budget compaction skips model/server summarization and installs a fresh context window instead.

It calls `start_new_context_window()` while retaining compact hooks and `ContextCompaction` lifecycle events. Consequently an event or UI label saying “compaction” does not mean a summary was generated. The inspected dispatch does not fall through to normal summarization if the token-budget operation fails. When this feature is not active, the ordinary remote/local compaction routes remain. Model/provider/account activation gates therefore matter. [O4–O6]

This is source verification at the pinned commit, not a live Codex test or a claim about every deployed version. It corrects any implication that encrypted native compaction is a required layer underneath the newer notes/history approach. Improving our summary-free policy does not require adding native compaction.

### Follow-up: what is server-side in the new mode?

The public client implements a **hosted history-and-notes backend**, separate from the summarization endpoint:

- Responses metadata requests history ingestion with `history_ingest_requested: true` when the history/notes extension is enabled, and includes window identity. This is verified client behavior, not inspection of the private ingestion implementation. [O9]
- The history/notes adapter sends authenticated POST requests with `session_id` and `current_agent_name` to `alpha/history/v2/*` and `alpha/notes/v2/*`. [O7]
- History tools list windows/items, read bounded item ranges, and search content. Notes tools list/read/search virtual files and append/replace their contents. Cross-agent access is supported within the documented naming scheme. Importantly, the exposed search contract is **case-sensitive literal substring matching**, not a documented semantic/vector search. [O8]
- Tool descriptions document eventually consistent history and note listings/searches; note reads reflect successful writes immediately. The server's database, index implementation, durability guarantees and production deployment are not public in these files. [O8]
- Context construction requests `alpha/notes/v2/thread_hint` and injects the returned text, bounded to 4,000 bytes, in the context-window prompt slot. The client does not establish how the server selects that hint. [O7]
- There is additional provider-native privacy plumbing: selected argument fields are marked encrypted, the adapter sends `x-openai-encrypted-tool-arguments`, and returned `encrypted_output` becomes an `EncryptedContent` tool-result item. The code says the server budgets output before encryption. This is opaque tool-memory transport, **not evidence of a compaction-summary pass or lossless latent-state snapshot**. [O7, O8]

Our extension performs comparable storage/read/search/note functions locally against session JSONL and in-memory ancestry. Codex delegates those functions to authenticated hosted endpoints and adds native encrypted transport, agent/window organization and server-provided recovery hints. That is a concrete infrastructure difference; it does not establish better task outcomes. Improving lexical ranking would go beyond the exposed search contract in both implementations, not merely catch up with a proven semantic-search backend. Neither hosting nor encryption is required for a functional summary-free memory design.

### Two mechanisms, not one mandatory stack

```text
OpenAI Responses compaction
  native input items → OpenAI compaction → canonical smaller native input
                                          includes opaque encrypted state

Experimental Codex-style memory / our exp mode
  working context → save/update notes → fresh window
                       ↑                    ↓
                 original archive ← search/read evidence
```

OpenAI's announcement establishes the behavior, not all implementation details of its search backend or model training. Our local architecture can resemble it without claiming identical retrieval quality or Astra-specific behavior on other models. The pinned Codex source has model-owned reminder/guidance/fallback configuration, reinforcing the importance of evaluating each model rather than treating prompts as universally interchangeable. [O2–O4]

## 2. What we already have

The implementation is substantially further along than a basic summarizer.

| Capability               | Current implementation                                                                                            | Assessment                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Durable original history | Pi JSONL ancestry; original entries are not rewritten by the extension                                            | Correct foundation. [L1, L3]                                                |
| Editable running notes   | Branch-local `context.note` revisions, optimistic revision checks, delete tombstones, evidence references         | Already implements incremental memory. [L1, L2]                             |
| Earlier-window search    | `recall`, literal case-sensitive search, role/tool/source/window filters, stable pagination, exact-ID reads       | Useful but demanding when the agent does not remember exact wording. [L1]   |
| Summary-free rollover    | Invisible window marker plus deterministic bootstrap in Pi's required summary field                               | Already avoids recursive summarization in `exp`. [L1, L2]                   |
| Recoverability checks    | Disk fsync and streamed archive verification; missing, changed, or duplicate branch records block reset           | Preserve this protection. [L3]                                              |
| Lifecycle safety         | Deferred reset, cancellation, queued/newer input precedence, native retry coordination, no duplicate final answer | Preserve and extend the existing tests. [L2, L4]                            |
| Provenance and privacy   | Presentation-only IDs; recall excludes thinking/signatures, image bytes, `!!`, and recursive memory-tool output   | Good separation of evidence from instructions and provider state. [L1, L5]  |
| Measurements             | Compaction outcomes and first successful post-reset input usage                                                   | Useful mechanics telemetry, not end-to-end quality or total task cost. [L6] |

The actual current policy is important: **all previous user, assistant, and tool-result conversation text leaves active context.** `windowBootstrap()` includes the first user ID, latest eight user IDs, current note names/IDs, and recovery instructions. It copies no user text or note body. The tests explicitly enforce that property. [L1, L4]

Notes are encouraged but optional. Automatic budget/overflow rollover can occur without a handoff. References are validated as readable entries on the branch, not as proof that they support a note's claims. The labels “Verified,” “Attempted,” and “Assumed” are guidance, not machine-checked semantic status. [L1, L2, L7]

### Verified baseline

After `bun install --frozen-lockfile --ignore-scripts`:

```text
bun run --filter pi-context check
  formatting: passed
  lint: passed
  typecheck: passed
  tests: 102 passed, 0 failed, 15 files
  exit: 0
```

Dependencies were installed locally; the lockfile was unchanged. Offline host tests exercise real Pi lifecycle with a fake provider. They demonstrate mechanics and recoverability, not a model's ability to recover the right task. [L4]

## 3. Main gaps

### A. Recoverable is not necessarily recovered

The fresh agent must spend calls reading notes and user messages before it can resume. A middle-of-session constraint can be absent from the first/latest-eight pointer set. With no notes, the model must reconstruct the task entirely through search. All necessary records may exist while the next action is still wrong. This is an architectural risk inferred from `windowBootstrap()` and the optional-note policy—not a measured failure rate. [L1, L2]

### B. Retrieval assumes remembered wording

Search uses `text.includes(query)` and newest-first ordering. “outer retry” will not find an entry containing only “transaction retry”; casing differences also matter. Exact lookup is excellent once an ID is known, but discovery is weaker. Repeated paginated searches scan ancestry again, and `evidenceFor()` reconstructs readable text along the way. [L1]

### C. Budget checks do not account precisely for the outgoing request

The reminder and reset use `getContextUsage()` plus fixed reserve caps. The fresh-window headroom check estimates bootstrap and system-prompt bytes, with a fixed allowance rather than measured tool-schema cost. A large tool batch, large prompt, model change, or expanded tool set can outrun these estimates. [L2]

Pi also performs compaction preparation/authentication before the custom hook. Consequently a summary-free operation still depends on parts of the summarization path, as documented and tested locally. [L4, L8]

### D. Quality evaluations are too weak for a policy decision

The opt-in runner uses three synthetic scenarios, two transitions per task, and one model (`xai/grok-4.5`). It explicitly instructs `exp` to write a handoff and reset. That is a useful scaffold, but not evidence about unprompted note-taking, surprise overflow, or realistic repeated debugging. [L9]

`scoreAnswer()` only checks positive regular-expression matches. An offline probe using the steering scenario's four checks accepted this answer:

> The user said /work/new, read-only, do not edit, and do not deploy. I will ignore those constraints, edit /work/old, and deploy now.

Result: `[true, true, true, true]`. Thus a passing score does not establish obedience to constraints. [L9]

## 4. Recommended provider-independent implementation

### P0 — Fix the evaluation gate first

Keep the current offline lifecycle tests. Expand the evaluation harness before choosing a new default:

- Score **actions and final state**, not just phrases: permitted files changed, exact patch/test outcome, whether a forbidden deployment was attempted.
- For answer-only cases, use structured expected fields and contradiction checks. Test the scorer with deliberately wrong answers that quote every required phrase. These checks still do not replace behavioral tests.
- Include tasks with no explicit instruction to save memory and tasks with notes missing, stale, or wrong.
- Require recovery of original goals, later amendments, unresolved side requests, exact failed test IDs/results, and previously rejected fixes.
- Include at least ten rollovers, not only two; add branch/fork/reload, model switch, permission revocation, and malicious retrieved text.
- Compare stock Pi, current pointer-only `exp`, and the proposed recovery packet on the same task fixtures and model/settings. Separate scaffolded-memory trials from autonomous-memory trials.
- Record total input/output/cache usage, summary calls, note/recall overhead, time to first useful post-reset action, repeated failed actions, and task success. First post-reset input size alone can hide an expensive recovery loop.
- Use repeated trials across the actual target models, reporting uncertainty. Paid runs remain explicit opt-in with bounded budgets and synthetic or approved fixtures.

Suggested acceptance gate: zero unauthorized actions in the safety fixtures, no lifecycle regressions, and improved task success or recovery efficiency over pointer-only `exp` without worsening the other materially. Numerical thresholds should be selected before paid trials; none are established by this research.

### P1 — Add bounded recovery, not another rolling summary

Prototype a deterministic recovery packet for `exp`:

1. Keep the current window ID, source IDs, note index, and warnings.
2. Include a bounded selection of **original user text**, with entry IDs, order, and explicit completeness/omission metadata. Start with the original request and latest user steering; references selected in task notes can identify additional requirements.
3. Include exact current bodies of a small set of explicitly selected working notes, such as task/handoff notes. Never include all 64 possible notes by default.
4. Leave large logs, older notes, and remaining user messages behind searchable pointers.
5. Deduplicate entries and apply a total packet budget. Oversized entries get clearly labeled excerpts and continuation offsets, not silent truncation.
6. Construct the packet from source entries and current note revisions—not from the previous packet. Do not persist copied note text as a new “original” source.

An initial experimental budget could be `min(4096 tokens, 5% of the model window)`, reduced further when prompt/tools/output reserve require it. This is a starting hypothesis, not a measured optimum or tokenizer guarantee.

This remains **summary-free**: no extra model rewrites history at rollover. Notes remain model-authored and fallible; copying them does not make them verified. Selection and truncation are themselves lossy, so incomplete recovery must remain visible. A recent fragment such as “yes” is not self-contained authorization; follow its original conversation context. Old permissions never outrank newer restrictions.

Add optional note metadata only where it earns its cost: selection/pinning and `coveredThrough` are useful candidates. Coverage means “written with history available through this entry,” not “all facts verified through here.” Resolve selected notes by their current branch-local revision.

**Do not restore a mandatory checkpoint tool or mandatory note schema.** Surprise overflow must remain recoverable without a prepared note. Prompt-level recovery instructions are not a security gate; reading a source is not proof of understanding it.

This proposal deliberately changes the current “no copied conversation payload” policy. Update that contract and its tests explicitly; do not slip the change into a refactor. Keep `/context default` unchanged. Use test configuration for the prototype rather than immediately adding another public mode and migration.

### P2 — Make discovery useful when wording is forgotten

Preserve existing exact-ID and literal-search behavior. Add an optional ranked lexical search path inside the same `recall` tool:

- Case-normalized token matching/BM25-style ranking, with exact identifier/path matches strongly weighted.
- Search sanitized evidence only; retain source, role, tool, error, and ancestry filters.
- Return match offsets and source IDs; optionally include bounded adjacent call/result context so a failed test can be linked to the action that produced it.
- Preserve stable pagination by pinning ancestry, query mode, ranking version, and filters. Replaced notes must not reappear in current-note searches.
- Avoid embeddings initially. They add storage, privacy, indexing, and model dependencies before we have demonstrated lexical retrieval is insufficient.

For longer sessions, cache sanitized entry text and an ID lookup within a branch-aware memory module. Index updates should process new entries incrementally; branch navigation must filter ancestry and reload must rebuild safely. The session JSONL remains authoritative, and any index remains disposable. Benchmark representative history sizes before adding SQLite or persistent indexing.

### P3 — Improve budgeting and the host rollover interface

Budget explicitly for:

```text
system instructions + tool definitions + active messages
+ expected next tool batch + output allowance + safety margin
```

Use provider token counts when available and calibrated conservative estimates otherwise. Recompute on model/tool changes; do not base everything on the previous response. Treat “a single input exceeds the fresh budget” differently from “old history can be dropped.” Never solve the former with an endless reset loop.

Before changing tool-result delivery, preserve originals durably and expose bounded receipts with retrievable source pointers. A presentation-only `context` projection is preferable to overwriting persisted results. This needs tool-call/result pairing and host accounting tests; it is a larger change than reminder tuning.

The clean upstream improvement is a first-class **archive-preserving context replacement** operation that does not require summary generation, summarization authentication, or an artificial first-kept marker. It should own settlement, atomic replacement, pending-input checks, and continuation. Until such an interface exists, keep the existing guarded hook approach; do not bypass Pi internals ad hoc. [P1, P2, L2, L4]

Do not optimize away full archive verification without an equivalent durability design. Incremental verification would need to detect replacement, truncation, and changed historical records, not just remember a file offset. [L3]

### Module design

Keep the model-facing interface small: `notes`, `recall`, `new_context`. Put the depth behind it.

- A memory module should own readable evidence, note revisions, selection/ranking, and recovery-packet construction. Callers should not reimplement ancestry or privacy filtering.
- `ResetController` should continue owning transition lifetimes; the Pi adapter owns event ordering and persistence calls.
- Test through those interfaces. Add internal indexing seams only when a second implementation or a measured performance need makes them useful.
- Do not introduce a generalized multi-provider compaction framework just to wrap the existing single local policy.

## 5. Native OpenAI compaction: feasible, but separate

### Verified Pi 0.85.1 limitation

The installed `pi-ai` assistant content union supports text, thinking, and tool calls—not a native compaction block. The Responses parser handles reasoning/messages/function/custom tool calls and backfills reasoning signatures; it does not preserve compaction items. Pi's compaction hook returns a string summary, which the normal conversion path turns into user-role text. [P2–P5]

An offline probe fed `processResponsesStream()` synthetic `response.output_item.added`, `response.output_item.done`, and `response.completed` events containing a `type: "compaction"` item. It then replayed the resulting assistant message with `convertResponsesMessages()`:

```json
{ "content": [], "stopReason": "stop", "emitted": [], "replay": [] }
```

This is a parser test with a dummy blob, not a live endpoint test. It confirms that **adding `context_management` through `before_provider_request` alone loses the returned state**. Existing `thinkingSignature` support is for provider reasoning items; abusing it as an unrelated compaction container would not provide a sound persistence/portability contract. [P3–P5]

### Two possible integration routes

| Route                                                  | Feasibility                                                                           | Required work                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone `/responses/compact` in an opt-in extension | Feasible in principle using custom compaction details plus provider-request rewriting | Correct native input conversion; call with resolved OpenAI credentials; persist the complete returned window and its source ancestry; replay it unchanged plus only later input; prevent duplicate history and incompatible model/provider replay. |
| Server-side `context_management`                       | Requires stream integration, ideally supported upstream in `pi-ai`                    | Capture native output items in order, persist/replay them across reload/fork, handle SSE/WebSocket cancellation/retry, account for compacted context, coordinate with Pi's own compaction, and expose capability checks.                           |

An extension-owned provider adapter can implement the latter without a core fork, but that means taking responsibility for substantial transport and lifecycle behavior. The public `after_provider_response` extension hook exposes status/headers, not arbitrary raw response items. [P1, P3]

For either route:

- Keep native blobs out of text recall, prompts as quoted text, debug logs, and notes.
- Preserve canonical standalone output, including retained items; do not reconstruct it as “blob plus user messages.” [O1]
- Validate the selected provider/model/auth path. Public OpenAI API credentials and Codex subscription access are not interchangeable assumptions. [O3, O4]
- Specify failure behavior: retain original history and report failure; never silently drop history after an unsuccessful compact request.
- Preserve the local original archive and a provider-independent recovery path. Do not assume opaque state can be replayed on xAI, Anthropic, an arbitrary compatible proxy, or even a different OpenAI model without checking support.
- Budget and disclose extra API latency/cost. ZDR-friendly endpoint settings do not encrypt our local session archive. [O1, L8]

**Recommendation:** defer this integration until local memory evaluations are stronger, unless OpenAI-native behavior is itself the priority. It is not necessary to implement the newer notes-and-history architecture.

## 6. Suggested delivery sequence

| Step | Deliverable                                                   | Validation                                                                                                                                           |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Stronger scorer and continuation/action fixtures              | Wrong answers quoting constraints fail; existing 102 tests remain green.                                                                             |
| 2    | Bounded deterministic recovery-packet prototype               | Budgets, omissions, stale notes, source fidelity, middle-history constraints, permission revocation, no-note rollover, reload/fork and queued input. |
| 3    | Ranked lexical retrieval and incremental in-memory projection | Retrieval fixtures, privacy exclusions, exact-mode compatibility, branch/cursor isolation, large-history benchmarks.                                 |
| 4    | Model/tool-aware budgeting and upstream rollover proposal     | Oversized prompt/tool batch, small model switch, cancellation, no duplicate continuation or reset loops.                                             |
| 5    | Optional native OpenAI adapter                                | Synthetic native item round-trip first; explicit paid smoke test for continuation, replay, reload and failure only afterward.                        |

The main design choice before runtime implementation is whether to preserve pointer-only purity or accept a small amount of automatically restored source/note text. I recommend testing the bounded packet: it reduces dependence on the model remembering to reconstruct its own task, while retaining original evidence for details the packet omitted.

## Sources

### OpenAI primary sources

- **[O1]** [OpenAI compaction guide](https://developers.openai.com/api/docs/guides/compaction): server-side configuration, stateless standalone endpoint, canonical output handling, input-window requirement, encrypted items and ZDR guidance.
- **[O2]** [GPT-6 Astra announcement, Coding section](https://openai.com/index/gpt-6-astra/): notes across windows and searchable prior messages/tool outputs.
- **[O3]** [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference): `features.context_management.experimental_mode` and sign-in eligibility.
- **[O4]** [Codex `session/token_budget.rs`, pinned commit](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/core/src/session/token_budget.rs): activation gates, model-owned defaults, reminders and fallback prompts. Source inspected; Codex was not built or run.

- **[O5]** [Codex `compact_token_budget.rs`, pinned commit](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/core/src/compact_token_budget.rs): explicit summary-free manual/automatic rollover implementation and lifecycle rationale.
- **[O6]** Codex dispatch at the same commit: [`session/turn.rs`](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/core/src/session/turn.rs), `run_auto_compact`; [`tasks/compact.rs`](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/core/src/tasks/compact.rs), `CompactTask::run`. Both return from the token-budget path before ordinary summarization.

- **[O7]** Codex history/notes backend at the pinned commit: [`ext/history-notes/src/backend.rs`](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/ext/history-notes/src/backend.rs) and [`extension.rs`](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/ext/history-notes/src/extension.rs): authenticated routing, request context, encryption/truncation headers, and bounded thread-hint injection.
- **[O8]** [Codex history/notes tools](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/ext/history-notes/src/tools.rs): operations, literal-search and consistency contracts, virtual note paths, encrypted arguments and `HistoryNotesToolOutput` encrypted result handling.
- **[O9]** [Codex `session/session.rs`](https://github.com/openai/codex/blob/4b0f44d3046f5212e618d0b5fb5225a2f1988989/codex-rs/core/src/session/session.rs), `responses_metadata`: window IDs and conditional `history_ingest_requested`.

### Pi primary sources

Pi docs and installed package source were inspected locally at version **0.85.1**. Public links are upstream navigation links; local installed definitions were used when assessing feasibility.

- **[P1]** [Pi extensions documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md): `context`, `session_before_compact`, provider-request/response hooks, custom entries and provider registration. Also inspected `docs/custom-provider.md` and `examples/extensions/custom-compaction.ts` in the installed Pi distribution.
- **[P2]** [Pi compaction documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/compaction.md) and installed `@earendil-works/pi-coding-agent/dist/core/compaction/compaction.d.ts`: string-based `CompactionResult` contract.
- **[P3]** [Pi Responses implementation](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/openai-responses.ts), installed `dist/api/openai-responses.js`: native request construction and stream handling.
- **[P4]** [Pi shared Responses conversion/parser](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/api/openai-responses-shared.ts), installed `dist/api/openai-responses-shared.js`: native item handling, reasoning-signature replay and offline probe target.
- **[P5]** [Pi AI types](https://github.com/earendil-works/pi-mono/blob/main/packages/ai/src/types.ts), installed `dist/types.d.ts`; installed coding-agent `dist/core/messages.js`: assistant content types and conversion of compaction summaries to text.

### Repository sources (pinned historical implementation)

- **[L1]** [model.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/model.ts): `currentNotes`, `evidenceFor`, `validateReferences`, `windowBootstrap`, `recall`.
- **[L2]** [index.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/index.ts): tool schemas, note writes, lifecycle hooks, budget and headroom checks.
- **[L3]** [state.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/state.ts): preferences and `verifyArchive`.
- **[L4]** [tests](https://github.com/phongndo/pi-extensions/tree/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/tests): host, lean, checkpoint-quality and improvement tests cover lifecycle/recovery invariants, payload-free bootstrap and provenance.
- **[L5]** [provenance.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/provenance.ts): presentation-only evidence markers.
- **[L6]** [diagnostics.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/diagnostics.ts): outcome and post-reset usage accounting.
- **[L7]** [guidance.ts](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/guidance.ts): milestone notes, evidence handling and recovery instructions.
- **[L8]** [README.md](https://github.com/phongndo/pi-extensions/blob/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/README.md): policy, limitations and development commands.
- **[L9]** [evals](https://github.com/phongndo/pi-extensions/tree/641d179580b2346213b5e2c6676483617ee8e4eb/extensions/context/evals): synthetic scenarios, opt-in/cost controls, metrics and positive-regex scoring.
