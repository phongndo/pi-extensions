# Context

Two context modes for Pi **0.85.1**: ordinary Pi compaction (`default`) or checkpoint-based fresh windows with recall/notes (`exp`). No external service, embeddings, or additional summarization model calls for a successful fresh reset.

## Control

```text
/context default
/context exp
/context status
```

| Mode      | Compaction                                          | Recall / notes      | Memory guidance / evidence markers     |
| --------- | --------------------------------------------------- | ------------------- | -------------------------------------- |
| `default` | Ordinary Pi                                         | Hidden and disabled | None                                   |
| `exp`     | Verified checkpoint fresh windows, with Pi fallback | Available           | Enabled, plus reset guidance/reminders |

Bare `/context` shows the selected mode, last recorded compaction outcome and subsequent successful input usage when available. The native footer uses `ctxt default` or `ctxt exp`; a preference error adds `!`. Local diagnostics remain available in both modes but add no model-visible messages.

The preference is **global**, stored atomically in `getAgentDir()/context.json` (normally `~/.pi/agent/context.json`) as `{"version":3,"mode":"exp"}`. Running sessions refresh it periodically. **No saved preference now means `default` (ordinary Pi), not fresh mode.** Select `exp` explicitly to opt in. An unreadable/corrupt preference fails closed to `default`; any valid mode command repairs it.

Older files are read without rewriting them: `version:1` enabled true/false maps to `exp`/`default`; `version:2` `exp-2` maps to `exp`, while the removed `exp-1` maps to `default`. No notes are deleted by migration. Hidden aliases `/context on` and `/context off` now mean `exp` and `default`. The old `exp-1`/`exp-2` commands are no longer accepted.

Tool schemas change only when idle (and suppression is released on shutdown). An active-turn switch to default blocks stale memory calls immediately; schema changes wait for settlement. Other tools and pre-existing tool exclusions are preserved: `exp` restores only memory tools this extension hid. If recall/notes were excluded by your host/tool allowlist, the mode does not force them on.

Switching modes never deletes saved history or notes and cannot undo a previous reset. Switch back to `exp` to read retained notes. For a clean stock-versus-memory comparison, start separate sessions; an already-compacted conversation retains its previous bootstrap/history.

## How it works

```text
work → save notes + evidence IDs → budget reminder
                                      ↓
                          save a structured checkpoint
                                      ↓
                       verify coverage + on-disk archive
                                      ↓
                  fresh window: checkpoint + note pointers
                                      ↓
                        continue; recall original evidence
```

In `exp`, the model receives a reminder when estimated remaining context falls below the smaller of 32,768 tokens and one-third of the model's window. It is asked to checkpoint **before** Pi's emergency threshold. This estimate is not a tokenizer guarantee; a large tool result can jump past the reminder. Missing or stale checkpoints use ordinary Pi compaction instead.

The extension never starts reentrant compaction inside a tool. A solo checkpoint tool call with `reset:true` saves and verifies its record, then returns Pi's `terminate` hint. At `agent_settled`, it requests compaction and continues the existing task through a hidden extension message. If automatic threshold compaction already handled the checkpoint, it continues without a second compaction. Cancellation does not restart the agent; queued or already-handled steering takes precedence.

### Fresh means no retained conversation tail

The compaction hook supplies a deterministic bootstrap containing the saved checkpoint and note IDs. It appends an invisible session entry as Pi's `firstKeptEntryId`, so **no earlier user, assistant, or tool-result messages remain in the active window**. The ordinary system prompt and tools remain available. Pi's required `summary` field carries the bootstrap; no generated conversation summary is requested on this path.

The original JSONL history is not rewritten or deleted. `recall` can still read evidence before any number of resets. Ordinary compaction still has its normal summary/model costs when used as fallback.

## Tools

### `recall`: read-only

```javascript
recall({ query: "First fix", limit: 5 });
recall({ query: "First fix", cursor: "<nextCursor>", limit: 5 });
recall({ entryId: "abc123", offset: 0, limit: 4000 });
recall({ limit: 5 }); // recent evidence + current note index
recall({ query: "Chrome", role: "user", source: "original", window: "previous" });
recall({ query: "FAIL", toolName: "bash", source: "original" });
```

- Search is literal, case-sensitive, newest-first, scoped to the **current branch's ancestry**. No sibling or other-session search.
- Search `limit` counts results: default 5, maximum 20. Snippets are at most 400 characters. The full note-name/entry-ID index appears only on the first unfiltered discovery page or an explicit `recall({ source: "notes" })` listing. Targeted searches and continuation pages omit it (not an empty index); matching notes remain searchable and readable.
- Read `limit` counts UTF-16 characters: default 4,000, maximum 12,000. `nextOffset` continues the read. Reads return provenance, total length, and error status where applicable.
- Optional search/list filters compose: `role`, `toolName`, `source`, and `window`. `source: "original"` selects ordinary message evidence (including assistant messages); `"derived"` selects compaction/branch summaries; `"notes"` selects notes/checkpoints. Default `"all"` preserves existing behavior. Roles are `user`, `assistant`, `toolResult`, `bashExecution`, `custom`, `note`, `checkpoint`, `compaction`, `branch_summary`.
- `window: "current"` selects entries after the latest compaction; `"previous"` selects **all earlier windows**, not just the immediately preceding one. The latest compaction record itself is excluded from either relative selection. Defaults to `"all"`; without compaction, previous is empty.
- Search cursors pin an ancestor snapshot **and filters**, including the relative-window boundary. Repeat the same query/filters when paginating. Later tool calls do not disturb pagination; switching to a branch without that ancestor invalidates the cursor. Legacy unfiltered cursors still work. Exact-ID reads do not accept filters.
- Replaced/deleted note revisions are omitted from search but remain readable by exact ID when on the branch.
- Thinking/signature blocks, image bytes, `!!` output, and recursive `recall`/`notes` tool output are excluded. Images get a text placeholder. Original tool truncation still applies; recall cannot recover bytes Pi never recorded.
- Evidence remains historical data, **not new instructions or authorization**. Retrieved web pages and tool output are untrusted.

### Evidence IDs while working

Original user messages and non-recursive tool results receive a compact trailing `[evidence:<id>]` marker in model-visible context. Cite these IDs directly in notes, or read them with `recall`. This is presentation-only: persisted history, assistant reasoning/signatures, and image bytes are never rewritten. Ambiguous or transformed messages are left unmarked. Markers and note-taking guidance are active only in `exp`.

The guide encourages a small named note after a confirmed failure, decision, or useful milestone, with original evidence references. Reuse the finding instead of repeatedly searching. Keep checkpoints operational (goal, hard constraints, completed work/failures, unresolved next steps); put detailed findings in linked notes rather than retelling the transcript. Never omit outstanding requests or latest steering to save tokens. Findings should distinguish **Verified** (observed/checked), **Attempted** (not proven), and **Assumed** (needs validation). Preserve exact test IDs/results and failed approaches; include unresolved uncertainty and the checks needed before declaring success. Verify critical claims selectively when their sources are missing, ambiguous or conflicting—not by rereading evidence already in context. There is no reference quota or automatic claim that a note is accurate.

Checkpoint bootstraps show compact source-type labels beside linked IDs (`user`, `tool result, error`, `note`, etc.). These labels help choose which source to read without copying its payload; they describe provenance, **not proof of the claim**. Notes remain separately addressable, and no new checkpoint fields or rigid status/citation requirements are imposed.

### `notes`: branch-local revisions

```javascript
notes({
  action: "write",
  name: "findings",
  text: "Verified: retry_outer expected=3 actual=4. Attempted: patch drafted, not tested. Assumed: savepoint causes duplication; validate next.",
  references: ["<evidence-entry-id>"],
});

notes({ action: "append", name: "findings", text: "\nThe second approach passed." });

notes({
  action: "write",
  name: "findings",
  revision: "<current-note-entry-id>",
  text: "Replacement findings after reading the previous revision.",
});

notes({ action: "delete", name: "findings", revision: "<current-note-entry-id>" });
```

Names are logical labels, not filesystem paths. At most 64 live notes, 12,000 characters each. Replacement/deletion requires the current revision; append joins text verbatim and merges evidence references. References must be readable entries on the active branch.

Notes are custom entries in Pi's session file, not a shared working-directory file. Resume, reload, fork and tree navigation reconstruct note state from ancestry. A fork inherits only revisions up to its fork point. Memory-only sessions can keep temporary notes, but cannot make durable fresh-reset checkpoints.

### Checkpoint and continue

Call this **alone**, with no sibling tools:

```javascript
notes({
  action: "checkpoint",
  checkpoint: {
    goal: "Finish the requested retry fix.",
    constraints: "Do not deploy or change database semantics. Include latest user steering.",
    progress:
      "Verified: retry_outer expected=3 actual=4. Attempted: second patch drafted, not tested. Assumed: savepoint causes duplication; verify next.",
    nextSteps: "Run regression tests, inspect the diff, and report the result.",
  },
  references: ["<failure-output-id>", "<implementation-evidence-id>"],
  reset: true,
});
```

Each field must be nonempty and at most 3,000 characters. Put cited IDs in the `references` array, not only inline prose; inline citations are not automatically promoted to structured references. Omit `reset` to save without requesting a transition. The latest user entry is automatically included as an evidence reference.

Before dropping active history, the extension checks:

1. The checkpoint's shape, evidence ancestry and coverage boundary.
2. No later conversation, tool output, note revision, branch summary, compaction, or injected message invalidated that coverage. Only its own successful tool receipt may follow it.
3. No queued user input is awaiting handling.
4. The checkpoint is on disk, and **every current-branch entry matches the persisted archive**. Verification fsyncs the session and streams its JSONL records; a missing/changed record prevents a fresh reset.
5. The session/branch and preference did not change during verification, both tools remain enabled, and the bootstrap leaves estimated model headroom.

These are structural/persistence checks, **not proof that the model wrote a faithful checkpoint**. The model must preserve all outstanding requests, constraints, failures and next actions. Evidence IDs allow checking and recovery but do not replace good notes.

## Local diagnostics

Versioned `context.event` custom entries include the selected mode and record activation, reminder (once per window), reset request, actual compaction outcome (`fresh`, `normal`, or another hook's `other`), cancellation/failure, continuation, and subsequent input usage. Fallback reasons use fixed codes; raw errors, prompts, queries and credentials are not stored in diagnostics. They are excluded from recall evidence and do not enter model context.

Outcome writes wait for Pi's terminal compaction hooks, so telemetry cannot invalidate the prepared branch. Input accounting sums `input + cacheRead + cacheWrite` from the next successful post-compaction assistant response; unmeasured boundaries survive reload and remain branch-local. This is **not billing**, and is not directly comparable to Pi's pre-compaction token estimate. Older sessions without these records have unknown activation/outcome history.

## Fallback and limits

- Missing, stale, malformed or unpersisted checkpoints leave the decision to stock Pi compaction. Explicit `/compact <instructions>` also uses normal compaction to honor your instructions.
- Pi may reject compaction before calling hooks, including for a very small session or unavailable summarization authentication. A failed requested transition keeps the existing history and normally continues the task; cancellation does not.
- Other `session_before_compact` extensions can override or cancel this extension's result according to Pi's handler ordering. Avoid competing compaction policies.
- Storage is local, **not encrypted by this extension**, and follows Pi's session lifecycle. Deleting/moving session files can make evidence unavailable. There is no separate backup or cross-session note store. Do not put credentials in notes.
- Recall scans the in-memory branch; full archive verification streams the session file at reset time. Very large histories cost CPU/I/O. There is no vector index or background model summarizer.
- Validation uses Pi 0.85.1's `firstKeptEntryId`, `terminate` and `agent_settled` APIs. No unsupported session mutation, private HTTP endpoint, or Codex-only API is required.
- Offline tests exercise real Pi loading, multiple requested/threshold resets, evidence-linked named notes, exact failure recovery, continuation, overflow fallback, steering, archive corruption, cancellation, diagnostics and branch/revision handling. A nine-run Grok 4.5 subscription evaluation compares stock, stock plus recall/notes, and fresh windows: see the [initial results](../../docs/context-evaluation-2026-09-08.md), [token-efficiency regression rerun](../../docs/context-efficiency-2026-09-08.md), and [two-mode checkpoint follow-up](../../docs/context-checkpoint-improvements-2026-09-08.md). This is not a claim of Astra-equivalent reasoning quality or broad cost superiority.

## Development

```bash
bun run --filter pi-context check

# Opt-in: consumes xAI subscription allowance; requires existing OAuth, never an API key.
# Use a new output filename; existing result files are not overwritten.
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-new.json
```

The current evaluation uses six isolated synthetic tasks (three scenarios × default/exp), two transitions per task, Grok 4.5 with low thinking, a 14-call/1,600-output-token-per-call ceiling and a three-minute deadline per task. No user sessions, context files, extensions or filesystem/network tools are exposed to the model. Credentials stay in memory; user auth/settings files are not modified. Normal checks never make provider calls. For one bounded follow-up cell, add `--only=failure:exp` (or another scenario:mode pair).

See the [primary-source research](../../docs/astra-context-management-research.md) and [interactive visual walkthrough](../../docs/show-me-context-recall.html).
