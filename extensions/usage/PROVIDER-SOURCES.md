# Subscription allowance contracts and sources

Initial scope: **OpenAI Codex, Grok, and Firecrawl**, with a provider-independent allowance interface for future integrations. Research and implementation use no live authenticated provider calls.

## Eligibility is separate from live support

Router and Usage include native OAuth logins only when the provider marks the method `isSubscription: true`. API keys, including key-based coding plans, and non-subscription OAuth are excluded. Firecrawl credits are Usage's explicit tool-provider exception, never a Router account.

An isolated Pi 0.85.1 `ModelRuntime` with an empty in-memory credential store reports subscription methods for `anthropic`, `github-copilot`, `kimi-coding`, `openai-codex`, and `xai`. OpenRouter and Radius OAuth methods are not marked subscriptions. This is an inventory observation, not a hardcoded eligibility list. See installed `@earendil-works/pi-ai/dist/providers/` definitions and `src/account-identity.ts` for the shared predicate.

The flat UI shows native subscription accounts even when no allowance adapter exists. Independent plans' percentages must not be summed or averaged. Missing fields/errors remain unknown, never zero. Local counters cannot reveal provider-wide remaining allowances.

## OpenAI Codex — implemented

Existing reader implements all returned usage windows and every banked reset, retaining each reset's status and own expiration. Normal remaining percentage is `max(0, 100 − used_percent)`. Credits are separate from banked resets.

See [CODEX-SOURCES.md](CODEX-SOURCES.md) for pinned first-party OpenAI endpoint/schema evidence. All status requests are passive GETs. Redemption is a separate mutation and is never called.

## Firecrawl — implemented

[Official credit-usage documentation](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage) specifies:

- `GET https://api.firecrawl.dev/v2/team/credit-usage`
- `Authorization: Bearer <token>`
- Successful JSON: `success: true`, `data.remainingCredits`, `data.planCredits`, `data.billingPeriodStart`, `data.billingPeriodEnd`.
- The balance belongs to the authenticated **team**, not an individual tool call or model account.

Display `remainingCredits` directly and label `billingPeriodEnd` as the billing-period end. Do not infer a remaining percentage from `planCredits`: the documented fields do not establish that all remaining credits are confined to that denominator. Missing/invalid remaining credits produce unavailable status.

Reuse the registered Pi Firecrawl provider when available. Standalone Usage uses the same Pi-native API-key auth definition as `extensions/web-tools/transport.ts`: `/login firecrawl` storage first, then `FIRECRAWL_API_KEY`. No credential copying, historical-credit requests, scraping, or billable web operations are needed to display the current balance.

## Grok / xAI — bearer billing reader implemented

Pi's native `xai` provider marks OAuth as subscription auth and resolves its access token as Bearer auth. Its device/token flow uses `auth.x.ai`. The inspected native files are `@earendil-works/pi-ai/dist/providers/xai.js` and `dist/auth/oauth/xai.js` in Pi 0.85.1.

Official reading:

- [Grok Build overview](https://docs.x.ai/build/overview)
- [CLI reference](https://docs.x.ai/build/cli/reference)
- [Management billing API](https://docs.x.ai/developers/rest-api-reference/management/billing) — team/admin credit/spending data is **not automatically a Grok subscription allowance**.

Read-only inspection of the installed first-party Grok executable found embedded documentation for `/usage`, which displays account allowance and session usage separately, and implementation strings for `extensions/billing.rs`, `/billing?format=credits`, `creditUsagePercent`, `currentPeriod`, and `monthlyLimit`. These strings **do not verify the request origin, schema nesting/units, headers, or compatibility with Pi's OAuth token**. They are insufficient to build a safe reader.

Inspected executable: the locally installed first-party `grok` binary; SHA-256 `4291021c1570a7c8610277a3d65490a5e54b50311e222c6b4614264f02a215b3`. The executable was not run and no Grok credentials were read. This is local first-party implementation evidence, not a stable public interface guarantee.

### CodexBar source check (follow-up)

The earlier investigation stopped too soon. CodexBar's own implementation documents the missing request origin, header and JSON nesting:

- [GrokCreditsProxyFetcher.swift](https://github.com/steipete/CodexBar/blob/c3a25fd85ff03eafcad13868205cb671b5a47046/Sources/CodexBarCore/Providers/Grok/GrokCreditsProxyFetcher.swift): GET `https://cli-chat-proxy.grok.com/v1/billing?format=credits`; headers `Authorization: Bearer <token>`, `x-xai-token-auth: xai-grok-cli`, `Accept: application/json`; percentage at `config.creditUsagePercent`; reset at `config.currentPeriod.end`, then `config.billingPeriodEnd`.
- [CodexBar Grok documentation](https://github.com/steipete/CodexBar/blob/c3a25fd85ff03eafcad13868205cb671b5a47046/docs/grok.md): prefers Grok CLI / OAuth, can use browser cookies and bearer gRPC fallbacks, and treats some team accounts as identity-only. The proxy can omit the percentage for some plans. The CLI's ACP billing method has also returned “Method not found”.

Both sources are pinned to `c3a25fd85ff03eafcad13868205cb671b5a47046`. They are primary sources for **how CodexBar works**, corroborating the installed first-party Grok CLI's billing path. They are not a stable public xAI API guarantee.

Usage now implements that **single read-only bearer billing GET**, using Pi's existing native `xai` OAuth login and locked refresh. Pi requests the `grok-cli:access` scope. No Grok auth-file reads, second login, browser cookies, CLI subprocess, management key, fake User-Agent, model request, or inference routing change. The token-auth header selects the Grok token-auth mode used by this billing endpoint.

Remaining percentage is `max(0, 100 − config.creditUsagePercent)`. A valid reset without a percentage retains the reset but shows unknown balance—never fabricated 100% remaining. Deliberately do **not** use CodexBar's `onDemandUsed / onDemandCap` fallback as a subscription quota: that denominator is a separate spending cap. No dollar conversion or per-product/Voice quota is inferred.

This is not full CodexBar fallback parity: settings enrichment, browser/WKE proof, ACP and protobuf/gRPC fallbacks are not implemented. A plan which withholds its percentage from the JSON endpoint may still lack a bar here even when CodexBar's fallback finds one. Requests rejected by xAI stay unavailable. Verification uses fake credentials/responses and native in-memory refresh tests, **not live authenticated success for the user's account**.

## Deferred research — not implemented

These providers remain eligible through native metadata, but their live readers are outside the initial scope:

- **Kimi Code:** first-party CLI uses Bearer GET `{platform.base_url}/usages`; the default base is `https://api.kimi.com/coding/v1`. Sources pinned to `86f136422a0aae6b217ea49e7ea1d2e8a1defcd2`: [usage/parser](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/ui/shell/usage.py), [platform defaults](https://github.com/MoonshotAI/kimi-cli/blob/86f136422a0aae6b217ea49e7ea1d2e8a1defcd2/src/kimi_cli/auth/platforms.py). Do not copy missing-value-to-zero fallbacks.
- **Copilot:** first-party client uses GitHub-token auth to fetch quota snapshots. Sources pinned to `5863f5a7088958050792b5dccbe8b46c6e13eccc`: [token manager](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/authentication/node/copilotTokenManager.ts), [quota parser](https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts). Exact request URL mapping and enterprise-domain token handling remain unverified here.
- **Claude:** local first-party executable contains a GET `/api/oauth/usage` reader and utilization/reset fields. Exact origin/headers/units still require verification before implementing.

## Implementation guardrails

Fixed official status origins/paths only; reject redirects, bound response bodies and timeouts, redact failures, retain Pi-owned refresh locking. No model requests to learn limits, admin keys, purchases, reset consumption, credential copying, cookie scraping, or extra login flows. Live snapshots stay in memory; Usage does not persist request history.
