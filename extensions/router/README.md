# Router

A separate, minimal Pi-native **subscription** account router. Requires Pi 0.85.1+. [Usage](../usage/README.md) is optional and independently loadable.

## Native account management

1. **`/login`** has one row per provider in Pi's native authentication-method picker: `OpenAI Codex ✓ 1`, or just `•` when no login is stored. No “stored”, “unconfigured”, or “Add account 2” rows.
2. Select the provider to **add another account directly**, using its existing native subscription OAuth flow. Only methods Pi marks `isSubscription: true` are pooled; API-key and non-subscription OAuth logins retain Pi's normal behavior. There is no add-versus-re-login menu.
3. **`/logout`** lists individual accounts with **email when exposed by the native credential**: `OpenAI Codex · work@example.com`. Select the specific login to remove. There are no account-number badges. Aliases appear alongside the provider and email when set. Without an alias or email claim, the row shows just the provider; emails are never guessed.
4. **`/router`** shows each provider's **session default in its header**, such as `OpenAI Codex: personal`, with its **ranked fallbacks** directly below. Type in the `> ` search field to filter by account name, alias, or provider; use ↑/↓ to navigate and **Space** to make the highlighted account that provider's session default. Accounts are grouped by provider (unrelated single-account providers are hidden). Move fallback rows with **Ctrl+↑/↓**. While filtered, this moves one position in the full provider order, including hidden accounts. Reordering does **not** change the default shown above. Headers are not selectable and accounts cannot move across providers. Changes are refused during a response.
5. The panel contains a search input, provider headers, ranked rows, and one line of controls. Rows show **rank and alias (blank if unset)**, with **✓** marking each provider's session default. Emails are hidden completely until revealed—no placeholder dots, generated “Account 1” labels, or subscription descriptions. Press **Ctrl+E** to reveal/hide the selected account's email; moving selection, reordering, changing search/default, or opening the alias input hides it again. Emails start hidden whenever the panel reopens and are never saved in `router.json` or published to Usage.
6. Press **Ctrl+N** to name the selected account, such as `Personal` or `Work`. **Enter saves the session default, fallback rankings, and aliases; Esc cancels all pending changes.** Use **`/router alias`** to name any signed-in subscription account, including a single-account provider; its native account picker keeps available emails masked, and submitting the input saves immediately. Blank input clears the alias; Esc leaves it unchanged. Aliases are single-line labels of up to 80 characters and never change provider or credential IDs.

Accidentally signing into the same identifiable account refreshes its existing credential **without adding a duplicate or changing its rank or alias**. OAuth account/issuer/subject/tenant identities are checked; email alone is never used to merge subscriptions in different organizations. Opaque OAuth credentials without stable identity can only be deduplicated when their access or refresh tokens match. No additional profile requests are made, and existing duplicate slots are not silently deleted.

The footer shows `route Personal` (or the generated account name without an alias) only when the current provider has at least two subscription accounts; otherwise the route label is hidden. There is no colon or session badge. It follows the account actually selected for a request, including fallback; before the first request it shows the eligible session default, or the highest-ranked eligible account. Emails and credentials are never displayed there.

There are no Router add/remove/login commands, modes, or separate secret prompts. With none eligible, `/router` gives a short notice rather than an empty panel. Rankings are **within a provider**, never across providers.

After an extra login is detected, the provider routes itself; no model or session switch is required. Login/logout update metadata immediately. Refreshes are serialized so a post-login refresh cannot reuse an older in-flight snapshot. Changes made in other processes are observed while idle (about once per second), and checked before user input/model changes. Unreadable rankings produce one redacted warning per failure episode instead of errors on every prompt; selected routes remain fail-closed until the file is repaired. A plain first login stays unmodified. A sole remaining extra login stays routed so it remains usable after the original is removed. Removing all accounts fails closed.

## Session account selection

Open **`/router`**, highlight an account using search and ↑/↓, and press **Space** to set it as that provider's session default without opening another picker, independently of its ranked fallback list. Each provider has one header showing its own default; there is no separate global account row. The choice stays pending until Enter saves the panel; Esc discards it along with pending ranking/alias edits. Saving captures the displayed default even if you only reordered fallbacks, so ranking edits do not switch your account.

**`/router account`** remains a direct shortcut that saves immediately; its **Automatic** option clears that provider's session default. Stop the current response before changing accounts.

- The preference is **per provider and per session**. It does not change `router.json` or affect other sessions.
- It survives **`/reload`, restart/resume, and compaction**. New sessions start in Automatic; forks inherit preferences on the copied branch, and `/tree` restores the preferences on the selected branch.
- Every routed request tries the preferred account first when eligible. On a recognized rate/quota limit, fallback uses the other accounts in global ranking order. Cooldowns and all existing no-replay protections still apply; the preference is not replaced by a fallback account.
- If the preferred login is removed or unavailable, routing uses the remaining eligible accounts. You can choose a replacement or clear the saved preference with Automatic.
- Only provider/account IDs are saved in Pi's session custom entries, outside LLM context—no emails, aliases, or credentials.

## Routing

- Try the session's preferred signed-in account first, otherwise the highest-ranked account, on every request; fall back to the next eligible account only on a recognized rate/quota limit.
- Stay on the **same provider and model**. No cross-provider or subscription-to-API switch. API keys, including key-based coding plans, are never eligible fallback accounts. The router rechecks stored credential types and uses an OAuth-only request adapter, so a login changed after discovery or selection cannot resolve through API-key or ambient auth.
- No replay after visible output, returned content, or recorded usage/cost. Account fallback, native auto-retry, and overflow/compaction signaling share one sticky check across the **whole stream**, including start events and every token/cost counter. A later empty error cannot erase earlier replay-blocking evidence. Authentication, permission, network, context, and server errors do not rotate accounts. An exhausted pool stops rather than triggering an endless retry loop.
- Honor exposed `Retry-After`; otherwise temporarily cool down rate-limited accounts for one minute, quota-exhausted accounts for one hour. Cooldowns are local to the loaded instance and reset on reload, not a global quota ledger.

### Failure recovery

`failures.ts` owns classification and credential-safe diagnostics; `router.ts` owns request-local selection and stream forwarding. Failures are classified once, before redaction, using both HTTP status and provider text.

| Failure                                                             | Recovery before any output/usage                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Recognized allowance limit                                          | Cool down the account and try the next eligible subscription                  |
| HTTP 408/5xx, known transport disconnect, or native retryable error | Preserve Pi's retry signal; no account rotation                               |
| Context overflow                                                    | Preserve Pi's automatic compaction signal                                     |
| Authentication or permission                                        | Stop with account-specific guidance; no rotation                              |
| Invalid request or unclassified failure                             | Stop with a category and safe HTTP status when available; never blindly retry |

Pi owns retry enablement, budget, cancellation, and backoff (`settings.retry`); Router adds no competing retry loop. Recovery retries the model request with existing tool results, not the tools themselves. If retries are disabled or exhausted, the request still stops. Output or usage blocks **all** automatic replay, including transient failures; interruption messages deliberately omit even numeric server status codes because Pi interprets those as retry instructions.

Thrown provider errors and streams ending without a terminal event follow the same policy as error events. Native adapter failures that replace a partial response with an empty error retain the preceding content/accounting. Cancellation wins over late provider errors. Optional diagnostic/footer/usage observers cannot fail the request. Raw exception text is withheld from all model-stream events, including start partials, because it can contain credentials.

### Inspect the upstream cause

**`/router errors`** shows the latest ten failures on the current session branch, newest first: timestamp, provider/model, account ID when selected, routing/request stage, category, HTTP status when exposed, replay safety, and the **sanitized upstream message**. Error codes and nested causes are retained when the native adapter exposes them. Failed allowance attempts are recorded even when a fallback succeeds. The command is read-only, works during a response, and does not refresh metadata, so broken `router.json` cannot prevent inspection.

Diagnostics are saved as `router:failure` session custom entries, **outside LLM context and Pi's retry/compaction detection**. They survive reload, resume, and compaction; `/tree` follows the selected branch, and new sessions start empty. The command displays at most ten records, but earlier records remain in the session file. No separate raw-error log is written. An in-memory copy remains available if session persistence fails.

Sanitization removes known selected/refreshed credential values and request-header values, common secret fields, bearer/basic auth, token patterns, URLs, emails, and terminal controls. Each upstream excerpt is limited to 2,000 characters; oversized source errors are explicitly omitted. Stack traces and attached request/config objects are not collected. **Redaction is best effort:** providers may echo arbitrary user content in error messages, so review diagnostics before sharing session files. Details live in this human-facing channel rather than the normal assistant error string because even a quoted `503` could otherwise trigger unsafe replay. Already-erased historical errors cannot be reconstructed.

Earlier versions could turn an opaque HTTP 503 or a plain `ECONNRESET` into `Account request failed`, suppressing native recovery. They could also leave partial transport failures retryable. Regression tests cover both directions, bounded native recovery after a tool result, and the real split app/router runtime path. The old generic error alone cannot identify which underlying provider failure occurred.

Native model adapters, reasoning/options, account-specific authentication endpoints, and Pi's locked OAuth refresh are reused. Credentials are never globally swapped or copied. Websocket/cache sessions are isolated per account and cleaned up on shutdown. Deferred/background responses are unsupported by routed models.

Routing is **transparent**: a provider with two or more subscription logins keeps its own id, name, and models in `/model`, and its stream chooses the account per request. There is no separate `<Provider> · Accounts` row and no switch away from the model you selected; select the provider's normal model. Unload Router to bypass routing. Sessions record the normal provider id, so a resumed transcript resolves even before Router loads, and any earlier `accounts-<provider>` selection migrates back on load. Future/dynamic Pi providers become eligible once their models are available and their native OAuth method is marked as a subscription; there is no hardcoded provider allowlist. Ambient-only authentication is not pooled. All providers use their existing Pi-supported auth flows; this does not add support for otherwise unsupported subscription plans.

Accounts share their source provider's models and endpoint configuration, and model-scoped `models.json` header overrides resolve against the normal provider id. Configure different endpoints as distinct native providers. Provider-wide headers are inherited. Each extra login is registered as a model-less native slot keyed by its credential id, so Pi can resolve its OAuth and `/logout` can remove it, but it never appears in `/model`.

## Storage

- Pi session JSONL: `router:session-account` custom entries store per-provider account preferences; `accountId: null` clears an override. `router:failure` custom entries retain sanitized upstream diagnostics for `/router errors`. Neither enters LLM context.
- `~/.pi/agent/router.json`: **rankings and account aliases only**, atomic writes, cross-process lock, mode `0600`. Concurrent edits to the same provider ranking or account alias are rejected rather than silently overwritten; independent edits merge. Saves fail immediately if another process holds the ranking lock; reopen and retry rather than blocking the terminal. Old ranking-only files remain readable. Native `/logout` clears the removed slot's alias.
- `~/.pi/agent/auth.json`: Pi's native protected-plaintext credential store. Extra logins use IDs like `account--openai-codex--2`. `/logout` owns deletion. Provider-side revocation is separate. Email/identity hints are read in memory from these credentials, not written to a separate index.
- A short-lived `router-login.lock` serializes final duplicate checks and account-slot allocation across processes. Native authentication happens **before** this lock; browser and secret prompts never hold it. Pi's native credential store still owns locked persistence.
- Earlier `accounts.json` entries are read for compatibility only; their names remain usable if their native credentials still exist. Removed credentials cannot be recreated by ranking metadata. Existing API/non-subscription slots and metadata are not deleted; old extra slots remain registered without models so native `/logout` can remove them, but Router excludes them from routing and its UI.

Paths respect Pi's agent-directory configuration. Aliases appear in Router, native `/logout`, and Usage when both extensions are loaded. They are local labels, not provider-side account names. Router does not inspect or log conversation payloads or collect billing history. Sanitized failure excerpts can contain content echoed by a provider; review them before sharing. It emits non-secret account metadata for the optional Usage extension, the set of **currently routed provider ids** (`router:routes`) so other extensions never re-derive pool membership from id prefixes or account counts, and per-attempt token/cost counters on the event bus.

## Test from a worktree

From the worktree root, without installing or merging:

```sh
bun install
pi --no-extensions -e ./extensions/router/index.ts -e ./extensions/usage/index.ts
```

Explicit `-e` paths still load with `--no-extensions`; your other extensions are disabled to avoid duplicate commands. This uses your normal Pi credentials/rankings. For an isolated test, prefix the command with `PI_CODING_AGENT_DIR="$(mktemp -d)"`; you will need to log in again. `/reload` picks up changes to these loaded paths.

Try `/login`, a second `/login`, `/router`, then `/usage`. No model request is needed just to inspect the menus; sending a prompt can incur normal provider charges. Reopening `/usage` shows remaining subscription allowances and the Firecrawl credit exception; verified readers perform read-only status requests when configured. Grok uses the bearer billing GET used by CodexBar, with Pi's native login; unsupported responses remain unavailable.

```sh
bun run --cwd extensions/router check
```

Pi 0.85.1 has no public auth-selector customization hook. `native-login.ts` contains a guarded, runtime-scoped adapter around the exported native UI classes and model runtime; it restores hooks on unload and leaves other runtimes alone. It does not edit the Pi installation, replace slash commands, or replace native secret/browser dialogs. Unsupported Pi internals fail explicitly rather than pretending to support the compact UI.

The suite renders the real native selector, exercises duplicate/concurrent/cancelled native logins, and tests fake model streams—not live provider logins or paid requests.

For package resource filtering, use `extensions: ["extensions/router/index.ts"]` to load Router alone.
