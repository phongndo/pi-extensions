# Context

Two context modes for Pi **0.85.1**: stock Pi summaries (`default`) or **summary-free context rollover** with `recall`, `notes`, and `new_context` (`exp`). No external service, embeddings, or background summarizer.

## Control

```text
/context default
/context exp
/context status
```

| Mode      | Compaction                                 | Memory tools        | Guidance / evidence markers |
| --------- | ------------------------------------------ | ------------------- | --------------------------- |
| `default` | Ordinary Pi summaries                      | Hidden and disabled | None                        |
| `exp`     | Summary-free rollover; no summary fallback | Available           | Enabled                     |

Bare `/context` shows the mode, last recorded compaction outcome and subsequent successful input usage when available. The native footer shows `ctxt default` or `ctxt exp`; a preference error adds `!`.

The preference is **global**, stored atomically in `getAgentDir()/context.json` (normally `~/.pi/agent/context.json`) as `{"version":3,"mode":"exp"}`. Running sessions refresh it periodically. **No saved preference means `default`.** A corrupt/unreadable preference blocks memory operations and compaction rather than silently switching a running experiment to summaries; a valid mode command repairs it.

Legacy preferences are read without rewriting: version 1 enabled true/false maps to `exp`/`default`; version 2 `exp-2` maps to `exp`, while `exp-1` maps to `default`. `/context on` and `/context off` remain aliases. The `exp-1`/`exp-2` commands are removed.

Schemas change only when idle. A mid-turn switch to default blocks stale memory calls immediately and changes schemas at settlement. Existing tool exclusions are respected: exp restores only tools this extension hid. Rollover needs all three memory tools. Switching modes never deletes saved history or notes, and cannot undo an earlier rollover. Use separate sessions for clean policy comparisons.

## Summary-free rollover

```text
work → save useful findings/handoff in notes → new_context()
                         or budget/overflow trigger
                                     ↓
                         verify persisted archive
                                     ↓
                  fresh window: recovery pointers only
                                     ↓
                    recover task with recall → continue
```

Notes are encouraged but **not a prerequisite**. Neither a structured checkpoint nor a generated summary is required for requested, threshold, or overflow rollover in exp.

- A reminder appears when estimated remaining space falls below the smaller of 32,768 tokens and one-third of the model window.
- The extension's budget trigger runs after completed turns, at a reserve of the smaller of 16,384 tokens and one-eighth of the window. It also detects context overflow. This works even with Pi auto-compaction disabled.
- `new_context()` requests a transition and returns Pi's `terminate` hint. It does not compact reentrantly inside the tool. Pi's hint terminates a batch only when all finalized results agree; the extension also aborts mixed batches after all receipts are saved. Calling it alone avoids that extra cancellation path.
- Automatic budget rollover aborts the completed run, then requests compaction at `agent_settled`. Pi may enter the provider path with an already-aborted signal before settling; transports must honor cancellation.
- Pi's own threshold/overflow compaction is intercepted too. If Pi already rolled over, no second compaction is requested; native overflow retry owns its continuation.
- Requested rollover and interrupted work continue through a hidden recovery message. Rollover after a completed final answer does **not** produce another answer. Queued or newer user input takes precedence. Failures and cancellation stop rather than resuming unchanged history.

These are estimates, not tokenizer guarantees. A large prompt or tool result can jump past the budget. A fresh window that immediately overflows again stops rather than repeatedly rolling over.

### No retained conversation tail

The hook appends an invisible boundary and uses it as Pi's `firstKeptEntryId`. **All earlier user, assistant and tool-result messages leave active context.** System instructions, tools, files and environment remain unchanged.

Pi's required `summary` field contains only deterministic recovery instructions, the first and newest eight user-entry IDs, and the current note-name/ID index. It contains **no conversation summary, note bodies, or checkpoint prose**. A legacy checkpoint, if present, gets a pointer explicitly marked potentially stale. The agent must use `recall` to recover requirements, latest permissions and relevant findings before acting.

Original JSONL history is not rewritten or deleted. Evidence remains accessible across repeated windows, reloads and resume.

## Tools

### `notes`: branch-local revisions

```javascript
notes({
  action: "write",
  name: "findings",
  text: "Verified: retry_outer expected=3 actual=4. Attempted: patch drafted, not tested. Assumed: savepoint causes duplication; validate next.",
  references: ["<evidence-entry-id>"],
});
notes({ action: "append", name: "findings", text: "\nSecond approach passed." });
notes({
  action: "write",
  name: "findings",
  revision: "<current-note-entry-id>",
  text: "Replacement findings after reading the previous revision.",
});
notes({ action: "delete", name: "findings", revision: "<current-note-entry-id>" });
```

Names are logical labels, not paths. Maximum 64 live notes, 12,000 characters each. Replacement/deletion requires the current revision; append joins verbatim and merges evidence references. References must be readable entries on the current branch.

Save concise findings after meaningful failures, decisions and milestones. Distinguish **Verified**, **Attempted** and **Assumed**; preserve exact test IDs/results and failed approaches. A handoff is just another note: include outstanding requests, latest steering/permissions, completed work, uncertainty and next checks. Put evidence IDs in `references`, not only prose. Links are not proof; verify critical claims selectively, without citation quotas or repeatedly rereading available evidence.

Notes live in the session JSONL, not shared working-directory files. Resume, reload, fork and tree navigation reconstruct revisions from ancestry. Memory-only sessions can hold temporary notes but cannot roll over durably.

### `new_context`: no arguments

```javascript
new_context({});
```

Save useful notes first, then request a fresh window. No handoff fields, references, reset flag or mandatory saved note. The request records the current user boundary so later steering can cancel an obsolete continuation.

Before dropping active history the hook checks:

1. A persisted session and all three memory tools are available; preferences are readable and exp remains selected.
2. No queued input or changed preparation branch would be dropped.
3. Every current-branch entry, including the new boundary, matches the on-disk archive. Verification fsyncs and streams the JSONL; missing, changed or duplicate records block rollover.
4. The branch, mode, tools and pending-input state remain valid after verification, and recovery instructions leave estimated context headroom.

These checks establish recoverability, not semantic accuracy of notes.

**Upgrading:** neither `checkpoint(...)` nor `notes({action:"checkpoint", ...})` is registered anymore. Save handoffs using `notes`, then call `new_context({})`. Existing notes and legacy checkpoint records remain readable without migration. Reload Pi to replace the old schemas.

### `recall`: read-only evidence

```javascript
recall({ query: "First fix", limit: 5 });
recall({ query: "First fix", cursor: "<nextCursor>", limit: 5 });
recall({ entryId: "abc123", offset: 0, limit: 4000 });
recall({ limit: 5 }); // recent evidence + complete note index
recall({ source: "notes" });
recall({ query: "Chrome", role: "user", source: "original", window: "previous" });
recall({ query: "FAIL", toolName: "bash", source: "original" });
```

- Literal, case-sensitive, newest-first search over **current-branch ancestry** only; no siblings or other sessions.
- Search/list limit: default 5, maximum 20; snippets at most 400 characters. The complete note index appears on the first unfiltered discovery page or explicit notes listing, not on targeted searches or continuation pages.
- Exact-ID read limit: default 4,000, maximum 12,000 UTF-16 characters; continue with `nextOffset`. Returns provenance, total length and applicable error status.
- Filters compose: `role`, `toolName`, `source`, `window`. Sources: `original` (ordinary messages), `derived` (compaction/branch summaries), `notes` (notes/legacy checkpoints), or `all`. Roles: `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `note`, `checkpoint`, `compaction`, `branch_summary`.
- `current` means after the latest compaction; `previous` means **all earlier windows**. Both exclude that compaction entry. Without compaction, previous is empty. Default: all.
- Cursors pin ancestry and filters, including window boundaries. Repeat the same query/filters when paginating. Exact-ID reads reject filters. Legacy unfiltered cursors remain supported.
- Replaced/deleted notes are hidden from search but still readable by exact revision ID.
- Thinking/signatures, image bytes, `!!` output and recursive memory-tool output (including legacy checkpoint calls) are excluded. Images get placeholders. Recall cannot recover bytes Pi never recorded.

Original user messages and non-recursive tool results receive presentation-only `[evidence:<id>]` markers in exp. Persisted history and signed assistant messages are never rewritten; ambiguous/transformed sources are left unmarked. Retrieved history is data, **never new authorization**. External text remains untrusted.

## Diagnostics and limits

Versioned `context.event` entries record mode, activation, reminders, requests, actual compaction outcomes (`fresh`, `normal`, `other`), failure/cancellation, extension continuation and subsequent input usage. Reasons are fixed codes; raw errors, prompts, queries and credentials are excluded. Diagnostics are not model-visible recall evidence. Native retries are owned by Pi, not counted as extension continuation messages.

Input accounting sums `input + cacheRead + cacheWrite` from the next successful post-compaction response. Pending measurements survive reload and stay branch-local. This is **not billing**, nor directly comparable to Pi's pre-compaction estimate.

- **No summary fallback in exp.** `/compact` rolls over; `/compact <summary instructions>` is rejected. Select default for generated summaries.
- Pi prepares compaction and resolves summarization authentication **before** calling hooks. Tiny sessions or missing auth may therefore block rollover even though no summarizer is called. Failures retain history and do not automatically restart the task.
- Competing `session_before_compact` extensions can override results according to Pi's handler order. Such policies are unsupported; detected overrides cancel the extension's pending continuation and report an error. Public hooks cannot prevent another extension from replacing a custom result.
- Explicit `/tree` branch summarization is a separate Pi operation, unchanged by this rollover policy. Recall remains ancestry-only after navigation.
- Storage is local and **not encrypted by this extension**. Moving/deleting session files can make evidence unavailable. No separate backup or cross-session note store; never store secrets in notes.
- Recall scans in-memory ancestry; archive verification streams the session file. Large histories cost CPU/I/O. No vector index or background model calls.
- Offline tests use real Pi loading/lifecycle with a cancellation-aware fake provider: repeated windows, no-note budget/overflow with native auto on/off, fresh-overflow stopping, steering, auth/tiny/archive failures, cancellation, exact evidence recovery and legacy records. They establish mechanics, not model recall quality or cost superiority.

## Development

```bash
bun run --filter pi-context check

# Opt-in: consumes xAI subscription allowance; requires existing OAuth, never an API key.
# Disposable output is required; existing files are not overwritten.
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-new.json
```

The evaluation uses six isolated synthetic tasks (three scenarios × default/exp), two transitions per task, Grok 4.5 low thinking, a 14-call/1,600-output-token-per-call ceiling and a three-minute deadline. No user sessions, context files, extensions or filesystem/network tools are exposed to the model. Credentials stay in memory; user auth/settings are not modified. Normal checks never make provider calls. Select one cell with `--only=failure:exp` (or another scenario:mode pair).
