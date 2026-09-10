# Usage

An independently loadable Pi-native dashboard for **remaining subscription allowances**. Requires Pi 0.85.1+. [Router](../router/README.md) is optional and adds active-account attribution and aliases.

```text
/usage                          # remaining allowances, all providers
/usage openai-codex              # one provider
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

## Native footer

Pi's native status slot shows the active subscription account's remaining windows beside the MCP/Router labels, for example `remaining 41%` for one regular limit, or `remaining 5h 72% · remaining weekly 45%` when both exist. Spark windows are omitted from the footer but remain in `/usage`. Router supplies the actual selected account, including fallbacks; without Router, Usage follows the current native OAuth model. API-key models have no usage status. Unknown or unsupported limits stay explicit.

Reads run in the background at startup, on model/account changes, and after an agent response. Input refreshes a snapshot older than one minute; repeated unchanged Router metadata events do not poll quotas. Opening `/usage` also updates the footer. Only the active account is queried for the footer, not other providers or Firecrawl. Switching accounts and shutdown abort pending reads; late responses cannot overwrite the new account. `PI_OFFLINE=1` disables live retrieval and hides the footer status. Full reset details and other accounts remain in `/usage`.

## Dashboard

`/usage` shows **Remaining**: flat provider headers with all accounts underneath, without expansion or OAuth/API badges. Scroll for additional accounts/windows/resets. Independent account percentages are **never summed or averaged** into a fictitious provider balance.

- Full-width native Pi borders follow terminal resizing; content stays compact within 96 columns. Native provider names and current Router aliases are used where available.
- Pi's cancellable loading UI appears immediately while live limits load. Esc (or your configured cancel key) closes it and aborts pending work.
- One allowance per aligned row, with a **short horizontal remaining bar**, percentage, and inline reset countdown. Account names appear on the first row; additional limits align underneath. Fixed, left-anchored columns are shared across providers, so renaming an account or limit never moves the bars, values, or reset times. Long names are ellipsized in the TUI; RPC retains full labels. Labels stay readable (`Weekly`, `Spark 5h`), and low remaining percentages are highlighted. No repeated “remaining”, checked timestamps, raw plan names, or zero extra-credit rows. Narrow terminals fall back to text.
- Unknown, unsupported, forbidden, and failed status responses stay **unavailable**, never zero or inferred from token counts.
- Banked resets use one compact countdown row: `Banked resets  3 available · ◷ 11d 23h · 25d 16m · 26d 2h`. No IDs, repeated titles, or full timestamps in the TUI. Each returned expiry remains represented; other statuses are grouped compactly, missing expiry stays unknown, and long lists wrap/scroll. RPC retains exact timestamps and IDs. Nonzero extra credits remain separate.
- Firecrawl credits are team-wide, not per-key consumption. Its plan credit count is not assumed to be the denominator of a balance that may include top-ups.

| Key                | Action                            |
| ------------------ | --------------------------------- |
| ↑ / ↓, PgUp / PgDn | Scroll allowances                 |
| Esc                | Close dashboard; return from help |
| `p`                | Cycle overall / provider filter   |
| `?`                | Shortcut help and allowance notes |

Scrolling and cancel honor injected Pi bindings and take precedence over letter shortcuts. The editor is temporarily replaced, not the footer/theme. RPC mode receives all remaining-status rows.

Reopen `/usage` to refresh all accounts. Dashboard status retrieval uses at most three accounts in flight, bounded bodies, per-request timeouts and a 20-second overall deadline; the native footer reads only the active account in the background on the events described above. `PI_OFFLINE=1` disables live retrieval. No background polling of quotas, paid model requests, purchases, reset consumption, or reserve opt-in. Native OAuth refresh may update Pi's credential store through its own locking. Live snapshots stay in memory.

## Persistence and privacy

Usage does not record requests, token totals, or price equivalents, and does not read or write a usage ledger. Existing history files from earlier versions under `~/.pi/agent/usage/` (or the configured agent directory) are left untouched and can be removed manually if no longer needed. History views, period arguments, and history shortcuts are no longer available.

Router is optional. For Usage alone, package resource filtering can use `extensions: ["extensions/usage/index.ts"]`.

## Checks / worktree testing

```sh
bun run --cwd extensions/usage check
pi --no-extensions -e ./extensions/router/index.ts -e ./extensions/usage/index.ts
```

Run from the worktree root. This uses normal Pi credentials; see [Router's isolated-test instructions](../router/README.md#test-from-a-worktree) for a fresh agent directory. Tests use in-memory credentials and fake status responses—no authenticated provider calls or paid requests. They cover subscription scope, future providers, stored-key precedence, adapter failures, remaining layout, provider filtering, every reset's expiry/scrolling, native refresh locking, and lifecycle cleanup.
