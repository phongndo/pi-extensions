# Usage

An independently loadable Pi-native dashboard for **remaining subscription allowances**, with recorded token-history graphs one key away. Requires Pi 0.85.1+. [Router](../router/README.md) is optional and adds ranked-account attribution and aliases.

```text
/usage                          # remaining allowances, all providers
/usage openai-codex              # one provider
/usage session                  # history period when pressing h
/usage 30d
/usage all
/usage 30d anthropic
```

## Scope and live support

Only native **OAuth logins whose Pi provider marks `isSubscription: true`** are included. API keys—including key-based coding plans—and non-subscription OAuth are excluded. **Firecrawl team credits are the explicit tool-provider exception**, not a model subscription or Router account.

| Provider                      | Remaining status                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex                  | Remaining percentage for every returned usage window, reset times, extra credit balance, and every returned banked reset with its own expiration   |
| Grok (`xai`)                  | Reported credit-pool percentage and reset via the same bearer billing GET used by CodexBar; uses Pi's Grok login. Missing percentages stay unknown |
| Firecrawl                     | Exact remaining team credits and billing-period end, using `/login firecrawl` or `FIRECRAWL_API_KEY`; a stored key takes precedence                |
| Other/future Pi subscriptions | Discovered automatically; shown as unsupported until a verified allowance adapter is added                                                         |

Grok reads the shared credit pool, not product/Voice quotas. This implements CodexBar's JSON billing path, not its browser/CLI/gRPC fallbacks; some plans omit a percentage. No live authenticated success for your account is claimed by the fake-response tests.

Eligibility follows **Pi metadata**, not a fixed provider allowlist. `allowances.ts` holds the adapter registry and provider-independent snapshot interface. Adding an adapter does not require changing the UI or account discovery. No additional integrations for Claude, Copilot, or Kimi are implemented yet. See [provider contracts and research](PROVIDER-SOURCES.md).

## Dashboard

`/usage` opens directly to **Remaining**: flat provider headers with all accounts underneath, without expansion or OAuth/API badges. Scroll for additional accounts/windows/resets. Independent account percentages are **never summed or averaged** into a fictitious provider balance.

- Full-width native Pi borders follow terminal resizing; content stays compact within 96 columns. Native provider names and current Router aliases are used where available.
- Pi's cancellable loading UI appears immediately while local history and live limits load concurrently. Esc (or your configured cancel key) closes it and aborts pending work. Remaining and Help views do not scan history on each render.
- One allowance per aligned row, with a **short horizontal remaining bar**, percentage, and inline reset countdown. Account names appear on the first row; additional limits align underneath. Fixed, left-anchored columns are shared across providers, so renaming an account or limit never moves the bars, values, or reset times. Long names are ellipsized in the TUI; RPC retains full labels. Labels stay readable (`Weekly`, `Spark 5h`), and low remaining percentages are highlighted. No repeated “remaining”, checked timestamps, raw plan names, or zero extra-credit rows. Narrow terminals fall back to text.
- Unknown, unsupported, forbidden, and failed status responses stay **unavailable**, never zero or an inference from local history.
- Banked resets use one compact countdown row: `Banked resets  3 available · ◷ 11d 23h · 25d 16m · 26d 2h`. No IDs, repeated titles, or full timestamps in the TUI. Each returned expiry remains represented; other statuses are grouped compactly, missing expiry stays unknown, and long lists wrap/scroll. RPC retains exact timestamps and IDs. Nonzero extra credits remain separate.
- Firecrawl credits are team-wide, not per-key consumption. Its plan credit count is not assumed to be the denominator of a balance that may include top-ups.

| Key                | Action                                             |
| ------------------ | -------------------------------------------------- |
| `h` (or `b`)       | Toggle remaining allowances / recorded history     |
| ↑ / ↓, PgUp / PgDn | Scroll allowances; select or scroll history rows   |
| Esc                | Close allowances; back/close history               |
| `p`                | Cycle overall / provider filter                    |
| `?`                | Shortcut help and accounting notes                 |
| Tab                | Cycle history period: session / 7d / 30d / all     |
| Enter              | In history, open provider or account/model details |
| `m`                | History grouping: provider / account / model       |
| `c`                | History graph: tokens / model-price equivalent     |
| `s`                | History token, cache and price details             |

Navigation, period, confirm, and cancel honor injected Pi bindings and take precedence over letter shortcuts. The editor is temporarily replaced, not the footer/theme. RPC mode receives all remaining-status rows followed by recorded totals.

Reopen `/usage` to refresh. Status retrieval happens **only on command invocation**, with at most three accounts in flight, bounded bodies, per-request timeouts and a 20-second overall deadline. `PI_OFFLINE=1` disables live retrieval. No background polling of quotas, paid model requests, purchases, reset consumption, or reserve opt-in. Native OAuth refresh may update Pi's credential store through its own locking. Live snapshots stay in memory.

## Recorded history

Press **`h`** for compact totals, aligned account/model columns, and token or price-equivalent histograms. Empty periods show one quiet message instead of repeated zero totals. `s` exposes input/output/cache counters and precise prices.

7d/30d include today and the preceding 6/29 UTC days. Session includes records made in this session, not inherited fork history. **All-time graphs cover the entire recorded span**; width-bounded bins combine long histories without discarding older usage. Narrow/short terminals use compact graph fallbacks. Changing accounts does not create a new conversation.

**Model-price equivalents are estimates, not invoices or extra subscription charges.**

- Collection begins when Usage is loaded; no transcript backfill or other-app spending import.
- Only subscription assistant responses are collected. Stored native login-method metadata takes precedence over Pi's cached availability/auth flag, which can lag startup, reload, or provider registration. Reading this metadata does not refresh tokens or call providers. Router reports every finalized subscription attempt, including failed fallback attempts, without double-counting the resulting assistant message.
- Routed compactions are attributed by Router. Native compaction events lack billed provider/auth attribution, so they are omitted rather than guessed from the currently selected model.
- Private tool/extension model calls, unexposed retries, interrupted calls without usage, and some nested/branch-summary usage may be absent. Ambiguous nested aggregates are not imported.
- Pricing comes from Pi/provider metadata. Zero can mean included usage or missing prices. Fees, taxes, discounts, subscription fees, and other-app spending are not inferred.
- Firecrawl tool activity is not imported into the model-token ledger. Its current credits are a separate snapshot.
- Previously saved API records remain on disk, but are not displayed or included in these subscription totals. Router cooldowns are not remaining allowances.

## Persistence and privacy

Records live in `~/.pi/agent/usage/YYYY-MM-DD-<random-shard>.jsonl`, respecting Pi's agent-directory configuration. History is shared across checkouts/worktrees that use the same agent directory; changing worktrees does not reset it. Each loaded instance uses an append-only shard; directories/files use `0700`/`0600`. The ledger stores record/session/account IDs and labels, provider/model, timestamp/outcome, subscription flag, token counters, and price equivalents.

**No prompts, completions, tool arguments, raw errors/responses, live balance/reset snapshots, auth headers, API keys, or OAuth tokens are saved in the ledger.** Account/session metadata is protected plaintext, not encrypted. Current Router aliases label signed-in accounts without splitting historical totals; new records retain their recorded label. Reusing a logged-out credential slot for a different identity can combine that slot's historical totals.

Reload/resume does not recount history. Reads deduplicate IDs and warn about malformed records or failed writes. Validation rejects non-integer/unsafe token counters, timestamps outside the four-digit UTC shard format, and control/bidirectional/line-separator characters in labels; every accepted timestamp can round-trip through shard storage. Nothing is automatically deleted or uploaded. Stop Pi before manually clearing ledger files.

Router is optional. Loading Router alone creates no usage ledger. For Usage alone, package resource filtering can use `extensions: ["extensions/usage/index.ts"]`.

## Checks / worktree testing

```sh
bun run --cwd extensions/usage check
pi --no-extensions -e ./extensions/router/index.ts -e ./extensions/usage/index.ts
```

Run from the worktree root. This uses normal Pi credentials; see [Router's isolated-test instructions](../router/README.md#test-from-a-worktree) for a fresh agent directory. Tests use in-memory credentials and fake status responses—no authenticated provider calls or paid requests. They cover subscription scope, future providers, stored-key precedence, adapter failures, privacy, full-history bins, remaining-first layout, every reset's expiry/scrolling, native refresh locking, and lifecycle cleanup.
