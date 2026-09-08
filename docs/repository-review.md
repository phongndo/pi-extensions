# Repository review

Scope: the complete repository, emphasizing bugs, bounded work, lifecycle cleanup, and invalid-state representation. Existing uncommitted Context/footer/MCP UI work was preserved. No commits, paid probes, credential changes, or global preference changes were made.

## Confirmed findings fixed

Each behavioral fix below was exercised by a failing regression before the correction, then rerun successfully.

| Area                   | Failure                                                                                                                                 | Correction                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared native footer   | A throwing sibling publisher evicted the initiating status, poisoned subsequent updates, and failed removals skipped separator refresh. | Remove only the failed publisher, continue refreshing healthy siblings, then propagate the error.                                                                                         |
| Context recall         | A two-result request materialized all 100 test messages; reference validation also converted unrelated evidence.                        | Iterate newest-first until the page plus lookahead is found; reuse the note index; validate only requested evidence IDs.                                                                  |
| Fast monitor           | Three timer ticks started three unresolved reads. Slow storage could continuously invalidate earlier snapshots.                         | Permit one outstanding background poll; retain independent explicit reads and generation-based freshness checks.                                                                          |
| MCP overlay validation | Toggling silently overwrote primitive JSON, malformed `mcpServers`, or malformed target definitions.                                    | Reject invalid existing shapes without changing their contents.                                                                                                                           |
| MCP overlay writes     | A predictable temporary symlink redirected an overlay write into an unrelated file.                                                     | Random, exclusively created private temporary files, with owned-file cleanup on failure.                                                                                                  |
| MCP result rendering   | Numeric ID `9007199254740993` displayed as `9007199254740992`; 401 characters of nested JSON expanded to 82,521 rendered characters.    | Keep raw text when numeric serialization would change tokens, nesting exceeds the formatting budget, or whitespace amplification is excessive. Ordinary JSON retains structured previews. |
| Web URL checks         | Trailing-dot names such as `localhost.` bypassed local-host checks.                                                                     | Normalize the DNS root dot before validation.                                                                                                                                             |
| Web response buffering | Output limits did not prevent reading oversized upstream bodies in full.                                                                | Stream and cancel responses exceeding 16 MiB before parsing; report a specific size-limit error. Preserve cancellation/error classification.                                              |
| Wizard helpers         | EOF passed human-input gates; a missing browser opener's warning was swallowed.                                                         | Fail input helpers on EOF, preserve Enter behavior, and emit the fallback warning outside redirected output.                                                                              |
| Context host test      | Instant fake responses shared the preceding compaction's millisecond timestamp, which Pi correctly treated as stale usage.              | Give fixture responses timestamps strictly after the previous compaction boundary. Production compaction behavior is unchanged.                                                           |

## Invalid-state hardening

- `FastStateSnapshot` now represents unknown, known, or failed state exclusively. An error cannot also claim Fast is enabled. Policy failures construct an error-only snapshot.
- `ResolvedMcpServer` is a transport-discriminated union. Stdio requires a command; HTTP/SSE require a URL; incompatible transport options are excluded. Resolution retains only options relevant to that transport.
- Compile-time assertions in both packages prevent these impossible combinations from becoming assignable again.
- Untrusted JSON and persisted records still require runtime checks. Partial editor state is intentionally representable while a question is being answered; it is not equivalent to a validated submitted answer.

## Coverage

Reviewed production modules in `src/` and all five extensions: Context, Fast Mode, MCP, Question, and Web Tools. Reviewed package/compiler/linter configuration, skill documents and supporting templates, theme configuration, shell templates, and Nix/hook setup. Existing tests cover branch isolation, checkpoint freshness and persistence, transport cleanup, cancellation, UI disposal, question validation, and request policy behavior.

The installed-host smoke test confirms that Pi 0.85.1 loads all six packaged extension entry points, discovers all 17 skills once, and expands all five aliases identically to native skill commands. Wizard regressions execute only the helper library: no browser, secrets, or provisioning stages run.

## Verification (original review snapshot)

- `node --test extensions/*/tests/*.test.ts tests/skills.test.mjs`: **173 passed, 1 intentionally skipped live test**.
- `node tests/pi-skills-smoke.mjs`: **passed**, installed Pi 0.85.1.
- Root and all five extension `tsc --noEmit` checks: **passed**.
- Root formatting/lint and each extension's strict lint configuration: **passed**.
- Threshold-reset host regression: **10/10 consecutive passes** after the final changes, in addition to the earlier focused repetitions.
- `bash -n` on both shell templates and `git diff --check`: **passed**.

`pnpm` was not on this shell's PATH, so checks used the installed workspace binaries directly rather than claiming `pnpm check` ran.

## Remaining risks and validation limits

- MCP now uses a cross-process lease plus atomic replacement; a six-process regression verifies concurrent updates. External editors and older extension versions that ignore the lock can still overwrite changes.
- Invalid later MCP transport definitions retain the previous definition with a warning. This existing fallback policy was not changed to disable previously configured servers silently.
- Context still scans branch metadata and must inspect history for sparse searches; deep pagination repeats earlier scans. Archive verification intentionally scales with persisted history. This is not an indexed or constant-time retrieval system.
- `/commit` was inspected but does not have dedicated regression coverage for overlapping invocations, session changes, or manual model selection during restoration. The host smoke test validates loading, not every command's lifecycle.
- Some workspace packages still pin Pi 0.82.1 development dependencies while the host and newer packages use 0.85.1. Current checks pass; dependency alignment remains a separate cleanup rather than unverified lockfile churn.
- Nix builds/fixed-output dependency hashes, macOS/Windows behavior, live Firecrawl/MCP services, and paid model behavior were not exercised. Shell templates were syntax-checked and helper-tested, not run through real provisioning.
- URL checks are basic input validation, not a DNS/redirect security boundary. Firecrawl must enforce private-network protection at provider egress. The new body cap is a deliberate limit: unusually large legitimate responses now fail with guidance to narrow the request.

Passing tests support these fixes; they are not a proof that every invalid state or concurrency failure is impossible.
