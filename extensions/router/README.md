# Router

A separate, minimal Pi-native **subscription** account router. Requires Pi 0.85.1+. [Usage](../usage/README.md) is optional and independently loadable.

## Native account management

1. **`/login`** has one row per provider in Pi's native authentication-method picker: `OpenAI Codex ✓ 1`, or just `•` when no login is stored. No “stored”, “unconfigured”, or “Add account 2” rows.
2. Select the provider to **add another account directly**, using its existing native subscription OAuth flow. Only methods Pi marks `isSubscription: true` are pooled; API-key and non-subscription OAuth logins retain Pi's normal behavior. There is no add-versus-re-login menu.
3. **`/logout`** lists individual accounts with **email when exposed by the native credential**: `OpenAI Codex · work@example.com`. Select the specific login to remove. There are no account-number badges. Aliases appear alongside the provider and email when set. Without an alias or email claim, the row shows just the provider; emails are never guessed.
4. **`/router`** shows only providers with **two or more stored subscription logins**, each under its own header (for example **OpenAI Codex** and **xAI**), with accounts ranked highest-first. Move a row with Pi's model-reordering keys (normally Alt+↑/Alt+↓; the panel shows your bindings). Headers are not selectable and accounts cannot move across providers. Moving an account to first is the quick switch. Changes are refused during a response.
5. Rows contain only **rank, alias (blank if unset), masked email (blank if unavailable)**. No generated “Account 1” labels or subscription descriptions. Press **`e`** to reveal/hide the selected account's email; moving selection, reordering, or opening the alias input hides it again. Emails start hidden whenever the panel reopens and are never saved in `router.json` or published to Usage.
6. Press **`n`** to name the selected account, such as `Personal` or `Work`. **Enter saves both rankings and aliases; Esc cancels all pending changes.** Use **`/router alias`** to name any signed-in subscription account, including a single-account provider; its native account picker keeps available emails masked, and submitting the input saves immediately. Blank input clears the alias; Esc leaves it unchanged. Aliases are single-line labels of up to 80 characters and never change provider or credential IDs.

Accidentally signing into the same identifiable account refreshes its existing credential **without adding a duplicate or changing its rank or alias**. OAuth account/issuer/subject/tenant identities are checked; email alone is never used to merge subscriptions in different organizations. Opaque OAuth credentials without stable identity can only be deduplicated when their access or refresh tokens match. No additional profile requests are made, and existing duplicate slots are not silently deleted.

There are no Router add/remove/login commands, modes, status widgets, or separate secret prompts. Single-account providers do not appear in the ranking list. With none eligible, `/router` gives a short notice rather than an empty panel. Rankings are **within a provider**, never across providers.

After an extra login is detected, the current model automatically uses that provider's account route. Login/logout update metadata immediately. Changes made in other processes are observed while idle (about once per second), and checked before user input/model changes. A plain first login stays on its native model. A sole remaining extra login stays routed so it remains usable after the original is removed. Removing all accounts fails closed.

## Routing

- Try the highest-ranked signed-in account first on every request; fall back to the next eligible account only on a recognized rate/quota limit.
- Stay on the **same provider and model**. No cross-provider or subscription-to-API switch. API keys, including key-based coding plans, are never eligible fallback accounts.
- No replay after visible output, returned content, or recorded usage/cost. Authentication, permission, network, context, and server errors do not rotate accounts. An exhausted pool stops rather than triggering an endless retry loop.
- Honor exposed `Retry-After`; otherwise temporarily cool down rate-limited accounts for one minute, quota-exhausted accounts for one hour. Cooldowns are local to the loaded instance and reset on reload, not a global quota ledger.

Native model adapters, reasoning/options, account-specific authentication endpoints, and Pi's locked OAuth refresh are reused. Credentials are never globally swapped or copied. Websocket/cache sessions are isolated per account and cleaned up on shutdown. Deferred/background responses are unsupported by routed models.

Routes appear under `<Provider> · Accounts` in `/model`, with IDs such as `accounts-openai-codex`. Selecting the corresponding original model while extra logins exist redirects back to the account route. Unload Router to bypass routing. Future/dynamic Pi providers become eligible once their models are available and their native OAuth method is marked as a subscription; there is no hardcoded provider allowlist. Ambient-only authentication is not pooled. All providers use their existing Pi-supported auth flows; this does not add support for otherwise unsupported subscription plans.

Accounts share their source provider's models and endpoint configuration. Configure different endpoints as distinct native providers. Provider-wide headers are inherited. Model-scoped `models.json` header overrides are resolved by provider ID in Pi; configure those on `accounts-<provider>` too if needed.

## Storage

- `~/.pi/agent/router.json`: **rankings and account aliases only**, atomic writes, cross-process lock, mode `0600`. Concurrent edits to the same provider ranking or account alias are rejected rather than silently overwritten; independent edits merge. Old ranking-only files remain readable. Native `/logout` clears the removed slot's alias.
- `~/.pi/agent/auth.json`: Pi's native protected-plaintext credential store. Extra logins use IDs like `account--openai-codex--2`. `/logout` owns deletion. Provider-side revocation is separate. Email/identity hints are read in memory from these credentials, not written to a separate index.
- A short-lived `router-login.lock` serializes final duplicate checks and account-slot allocation across processes. Native authentication happens **before** this lock; browser and secret prompts never hold it. Pi's native credential store still owns locked persistence.
- Earlier `accounts.json` entries are read for compatibility only; their names remain usable if their native credentials still exist. Removed credentials cannot be recreated by ranking metadata. Existing API/non-subscription slots and metadata are not deleted; old extra slots remain registered without models so native `/logout` can remove them, but Router excludes them from routing and its UI.

Paths respect Pi's agent-directory configuration. Aliases appear in Router, native `/logout`, and Usage when both extensions are loaded. They are local labels, not provider-side account names. Router does not collect usage history, prompts, or billing information. It emits non-secret account metadata and per-attempt token/cost counters for the optional Usage extension.

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
