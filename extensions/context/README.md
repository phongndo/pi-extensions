# Context

Local task notes, branch-aware historical evidence, and checkpoint-based fresh windows for Pi **0.85.1**. Enabled by default. No external service, embeddings, or additional model calls for a successful fresh reset.

## Control

```text
/context on
/context off
/context status
```

Bare `/context` shows status. Like Fast Mode, the preference is **global**, stored atomically in `getAgentDir()/context.json` (normally `~/.pi/agent/context.json`). Running sessions refresh it periodically. A missing preference defaults to on; an unreadable/corrupt preference safely disables fresh resets until repaired with `/context on` or `/context off`.

**Off restores normal Pi compaction.** `recall` and `notes` remain available; nothing saved is deleted. Off does not undo an earlier reset. The native footer shows `ctxt recall` when enabled or `ctxt normal` when off (`ctxt normal !` on a preference error). Recall mode uses checkpoint-based fresh windows; normal mode uses Pi compaction. The `recall` tool remains available in both modes. Visible package statuses are separated by `·`, for example `ctxt recall · speed fast · mcp 1/2`.

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

The model receives a reminder when estimated remaining context falls below the smaller of 32,768 tokens and one-third of the model's window. It is asked to checkpoint **before** Pi's emergency threshold. This estimate is not a tokenizer guarantee; a large tool result can jump past the reminder. Missing or stale checkpoints use ordinary Pi compaction instead.

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
```

- Search is literal, case-sensitive, newest-first, scoped to the **current branch's ancestry**. No sibling or other-session search.
- Search `limit` counts results: default 5, maximum 20. Snippets are at most 400 characters. Every search includes the current note-name/entry-ID index.
- Read `limit` counts UTF-16 characters: default 4,000, maximum 12,000. `nextOffset` continues the read. Reads return provenance, total length, and error status where applicable.
- Search cursors pin an ancestor snapshot. Later tool calls do not disturb pagination; switching to a branch without that ancestor invalidates the cursor.
- Replaced/deleted note revisions are omitted from search but remain readable by exact ID when on the branch.
- Thinking/signature blocks, image bytes, `!!` output, and recursive `recall`/`notes` tool output are excluded. Images get a text placeholder. Original tool truncation still applies; recall cannot recover bytes Pi never recorded.
- Evidence remains historical data, **not new instructions or authorization**. Retrieved web pages and tool output are untrusted.

### `notes`: branch-local revisions

```javascript
notes({
  action: "write",
  name: "findings",
  text: "The first retry boundary failed. Preserve the outer transaction.",
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
      "First fix failed because it retried a partial transaction. Second fix is implemented.",
    nextSteps: "Run regression tests, inspect the diff, and report the result.",
  },
  references: ["<failure-output-id>", "<implementation-evidence-id>"],
  reset: true,
});
```

Each field must be nonempty and at most 3,000 characters. Omit `reset` to save without requesting a transition. The latest user entry is automatically included as an evidence reference.

Before dropping active history, the extension checks:

1. The checkpoint's shape, evidence ancestry and coverage boundary.
2. No later conversation, tool output, note revision, branch summary, compaction, or injected message invalidated that coverage. Only its own successful tool receipt may follow it.
3. No queued user input is awaiting handling.
4. The checkpoint is on disk, and **every current-branch entry matches the persisted archive**. Verification fsyncs the session and streams its JSONL records; a missing/changed record prevents a fresh reset.
5. The session/branch and preference did not change during verification, both tools remain enabled, and the bootstrap leaves estimated model headroom.

These are structural/persistence checks, **not proof that the model wrote a faithful checkpoint**. The model must preserve all outstanding requests, constraints, failures and next actions. Evidence IDs allow checking and recovery but do not replace good notes.

## Fallback and limits

- Missing, stale, malformed or unpersisted checkpoints leave the decision to stock Pi compaction. Explicit `/compact <instructions>` also uses normal compaction to honor your instructions.
- Pi may reject compaction before calling hooks, including for a very small session or unavailable summarization authentication. A failed requested transition keeps the existing history and normally continues the task; cancellation does not.
- Other `session_before_compact` extensions can override or cancel this extension's result according to Pi's handler ordering. Avoid competing compaction policies.
- Storage is local, **not encrypted by this extension**, and follows Pi's session lifecycle. Deleting/moving session files can make evidence unavailable. There is no separate backup or cross-session note store. Do not put credentials in notes.
- Recall scans the in-memory branch; full archive verification streams the session file at reset time. Very large histories cost CPU/I/O. There is no vector index or background model summarizer.
- Validation uses Pi 0.85.1's `firstKeptEntryId`, `terminate` and `agent_settled` APIs. No unsupported session mutation, private HTTP endpoint, or Codex-only API is required.
- Offline tests exercise real Pi loading, multiple requested/threshold resets, continuation, overflow fallback, steering, archive corruption, cancellation and branch/revision handling. **No paid cross-model quality or cost evaluation has been run.** This implements the core workflow, not a claim of Astra-equivalent reasoning quality.

## Development

```bash
pnpm --filter pi-context check
```

See the [primary-source research](../../docs/astra-context-management-research.md) and [interactive visual walkthrough](../../docs/show-me-context-recall.html).
