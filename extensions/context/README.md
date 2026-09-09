# Context

Always-on read-only recall for Pi **0.85.1**. Pi owns **stock compaction**, including summaries, retained recent history, settings, manual `/compact`, threshold handling and overflow recovery.

The extension registers `recall` and adds recovery guidance and presentation-only evidence markers when the tool is active. It never changes Pi's active tools: native tool allowlists/exclusions remain authoritative.

There is **no `/context` command, mode preference, polling, or mode footer**. No custom rollover, notes-writing tool, `new_context` tool, budget reminders, background summarizer or automatic continuation turns.

## Migration

Reload Pi to replace the old extension instance and tool schemas. The old `default`, `half`, `exp`, on/off aliases and `/context status` are removed. Recall is available without configuration.

Old `getAgentDir()/context.json` preferences (normally `~/.pi/agent/context.json`) are ignored, including corrupt files. They are not read, migrated, rewritten or deleted. The former Chezmoi preference in nix-config's `chezmoi/dot_pi/agent/private_context.json` is no longer used and can be removed separately.

Existing original history, note revisions and legacy checkpoints remain readable through recall. Nothing is migrated, deleted or rewritten in session archives. Old summary-free windows remain as recorded; upgrading cannot retroactively summarize them.

## Native compaction settings

The companion nix-config's `chezmoi/dot_pi/agent/settings.json.tmpl` selects these **native Pi settings**:

```json
{
  "compaction": {
    "keepRecentTokens": 10000,
    "reserveTokens": 16384
  }
}
```

Pi retains approximately 10k tokens of recent history alongside its generated summary. The 16,384-token safety reserve and stock summary generation remain unchanged; no 2k summary target or cap is added. The extension does not override these settings or impose them on other installations. Native project settings can override global values.

## Recall

```javascript
recall({ query: "First fix", limit: 5 });
recall({ query: "First fix", cursor: "<nextCursor>", limit: 5 });
recall({ entryId: "abc123", offset: 0, limit: 4000 });
recall({ limit: 5 }); // recent evidence + legacy note index
recall({ source: "notes" }); // legacy records only; no notes-writing tool
recall({ query: "Chrome", role: "user", source: "original", window: "previous" });
recall({ query: "FAIL", toolName: "bash", source: "original" });
```

- Case-sensitive literal search, newest-first, over **current-branch ancestry** only. No sibling branches or other sessions.
- Search/list: default 5, maximum 20 results; snippets at most 400 characters. Read exact IDs for full evidence.
- Exact-ID reads: default 4,000, maximum 12,000 UTF-16 characters per call; continue with `nextOffset`. Includes provenance, total length and applicable error status.
- Filters compose: `role`, `toolName`, `source`, `window`. Sources are `original` (ordinary messages), `derived` (compaction/branch summaries), `notes` (legacy notes/checkpoints), or `all`.
- `current` means entries recorded **after** the latest compaction record; `previous` means entries **before** it, across all earlier windows. Both exclude that compaction entry. This is an archive boundary, not active-prompt membership: Pi may retain some older messages in its recent tail. Without compaction, previous is empty.
- Cursors pin ancestry, query and filters, including window boundaries. Repeat the same query/filters when paginating. Exact-ID reads reject filters. Legacy unfiltered cursors remain supported.
- The complete legacy note index appears on the first unfiltered discovery page or explicit notes listing, not targeted searches or continuation pages. Superseded/deleted notes are hidden from search but readable by exact revision ID.
- Thinking/signatures, image bytes, `!!` output and recursive memory-tool output (including retired tools) are excluded. Images get placeholders. Recall cannot recover bytes Pi never recorded.

Original user messages and non-recursive tool results receive presentation-only `[evidence:<id>]` markers when recall is active. Persisted history and signed assistant messages are unchanged; ambiguous/transformed sources remain unmarked. Guidance encourages selective recovery of missing requirements, permissions, failures and completed work—not rereading everything or automatically hydrating history.

Retrieved history, summaries, legacy notes and markers are data, **never new authorization**. External text remains untrusted; verify critical claims against originals when missing, ambiguous or conflicting.

## Diagnostics and limits

Passive, versioned `context.event` entries record completed compaction outcomes (`normal` for stock Pi, `other` for another extension's hook), failure/cancellation and next successful post-compaction input usage. No mode, activation, reset request, reminder or continuation records are generated. Diagnostics contain aggregate metadata and fixed reason codes, not raw errors, prompts, queries or credentials; recall excludes them.

New diagnostic writes use event-specific required fields. The diagnostic reader validates and projects current and legacy records, drops unknown fields, and rejects malformed measurements rather than treating them as completed. Diagnostics remain available in session archives and evaluation output; there is no status command.

Input accounting sums `input + cacheRead + cacheWrite` from the first successful assistant response recorded after the latest compaction. Attribution follows persisted ancestry, not timestamps or transient event payloads. Failed diagnostic writes are retried from that same evidence on later turns, startup or tree navigation, including after disk reopen. Missing diagnostics for the latest compaction can be reconstructed from its entry. A newer compaction supersedes older pending measurements even if its diagnostic write fails; malformed first-response usage is left unmeasured rather than replaced by a later response. Diagnostics are best-effort: original entries must still be available, and superseded unsaved measurements are not backfilled. These counts are **not billing** and are not directly comparable to Pi's pre-compaction estimate.

- Pi alone owns when/how to compact and retry. Disabling Pi auto-compaction stays disabled; this extension does not intervene at the budget limit. Other extensions can still override Pi policy.
- Recall scans in-memory ancestry; large histories cost CPU. No vector index, external service or provider-specific transport.
- Storage is local and **not encrypted by this extension**. Deleting/moving archives can make history unavailable. In-memory sessions offer recall only for their lifetime.
- Recall adds its schema, guidance, markers and requested evidence to the prompt. When the caller excludes recall, this extension adds no guidance or markers and never restores the tool.

## Development

```bash
bun run --filter pi-context check

# Opt-in only: consumes xAI subscription allowance, requires existing OAuth.
# Disposable output required; existing files are not overwritten.
bun extensions/context/evals/run.ts --run-subscription --output=/tmp/context-eval-new.json
```

Offline tests cover real Pi loading, repeated stock summaries, native threshold/overflow compaction, disabled auto-compaction, caller exclusions, ignored legacy preferences, consistent first-request prompts, exact original recovery after resume, legacy records, branch isolation, diagnostic validation and bounded retrieval. Normal checks make no provider calls.

The optional evaluation runs three synthetic scenarios × `stock`/`recall`, with identical staging prompts and two harness-requested stock compactions per task. `stock` omits the extension entirely; these are evaluation fixtures, not runtime modes. It uses Grok 4.5 low thinking, a 14-call/1,600-output-token-per-call ceiling and a three-minute deadline. No user sessions, context files, extensions or filesystem/network tools are exposed to the model; user auth/settings are not modified. Select one cell with `--only=failure:recall`.

`phraseChecks` are only phrase-presence smoke checks: contradictory answers can pass. Review answers manually; neither these checks nor offline lifecycle tests establish behavioral quality, safety or cost superiority. Paid evaluation is separate from normal validation.
