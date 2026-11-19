# Pi Fast Mode

A global speed preference (**Off**, **Fast**, or **Ultrafast**) that adds each provider's own speed field to eligible requests. Requires Pi **1.5.2+**; compatibility tests target 1.5.2.

Fast mode **does not change models or reasoning effort, establish account entitlement, or guarantee a speedup**. It costs more (plan credits or premium token rates), and Fast and standard requests use separate prompt caches.

## Use it

| Command                  | Effect                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `/fast`                  | Toggle Off ↔ Fast                                                      |
| `/fast on` / `/fast off` | Fast / Off                                                             |
| `/ultrafast`             | Toggle Off ↔ Ultrafast                                                 |
| `/ultrafast on` / `off`  | Ultrafast (falls back to Fast where only Fast exists) / Off            |
| `/fast status`           | Preference, per-model support, paused speeds, and the last request     |
| `/fast refresh`          | Refresh capabilities and clear paused speeds without changing anything |

The footer shows the speed the **current model** will get: `speed ultrafast`, `speed fast`, `speed fast (no ultra)` (Ultrafast chosen, model has only Fast), `speed fast (ultra ?)` (Ultrafast support unknown), `speed standard (fallback)` (provider refused or rate-limited it), `speed unavailable`, `speed ?`, or `speed !` (state error). It is hidden when off.

## Providers

| Provider (official endpoint only)          | Fast                                                      | Ultrafast                                                                    | Support source                                                                            |
| ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `openai` (API key or Sign in with ChatGPT) | `service_tier: "priority"`                                | `service_tier: "ultrafast"`                                                  | Documented model lists                                                                    |
| `openai-codex` (ChatGPT backend)           | `service_tier: "priority"`                                | the catalog's tier id, verbatim (as Codex does)                              | Account catalog, then documented list; Ultrafast only from the catalog                    |
| `anthropic`                                | `speed: "fast"` (+ `fast-mode-2026-02-01` beta on Opus 5) | —                                                                            | Documented models: Fable 5.2, Mythos 5.2, Opus 5.5, Opus 5                                |
| `vercel-ai-gateway`                        | `providerOptions.gateway.speed: "fast"`                   | `providerOptions.openai.serviceTier: "ultrafast"`, routed `only: ["openai"]` | Fast where the catalog lists a `-fast` variant; Ultrafast on documented `openai/*` models |
| Opted-in Responses proxy (below)           | `service_tier: "priority"`                                | only from model metadata                                                     | Same lists as Codex, no account catalog                                                   |

On AI Gateway, Ultrafast only pins routing to OpenAI when you haven't set `gateway.only` yourself; if your allowlist excludes OpenAI or you set your own `openai.serviceTier`, the request asks for Fast instead.

Model metadata wins over every list: a model with `service_tiers`/`serviceTiers` (`priority`/`fast`, `ultrafast`) or `additional_speed_tiers` is used as advertised. Unknown future names are never enabled by pattern. The lists live in [`capabilities.ts`](capabilities.ts). xAI and other providers are untouched.

**Not yet verified against live servers:** `ultrafast` on any route, `priority` with Sign in with ChatGPT on api.openai.com, `speed` with Claude subscription (OAuth) credentials, and the AI Gateway shape (taken from Vercel's fx agent, unconfirmed on the gateway's Messages route). The OpenAI Ultrafast list comes from the ChatGPT speed page, which is plan-gated (Pro $500, eligible Enterprise/Edu); Claude Fast needs usage credits on subscriptions or a provisioned Console org. The refusal fallback below keeps a wrong guess from failing a turn.

## Refusals and fallback

When a provider refuses a speed this extension added, it steps down (Ultrafast → Fast → standard) within the same request and pauses each refused speed for that model:

- Anthropic `429` or `529` that points at Fast (an exhausted `anthropic-fast-*` limit header, or an error about the Fast limit or capacity): retry at standard and pause until `retry-after` (default 60 s). Org-wide rate limits and general overload stay with Pi's normal retries.
- `400`/`403`/`404`/`422` that names the speed setting (OpenAI `error.param` such as `service_tier`, or a message about the service tier, Ultrafast or Fast mode): pause until `/fast refresh` or any preference change, from any session.

A step down restores the caller's own values: OpenAI gets an explicit `service_tier: "default"` (so a project default of Fast can't apply), Anthropic drops the Fast beta it added from `anthropic-beta`, and AI Gateway gets the caller's original `providerOptions`. Later sends of the same request, such as provider retries, keep the lower speed, and Pi's cost estimate follows the speed actually sent. You get a one-line warning per step. Other errors are never retried. Fallback covers HTTP transports, including zstd-compressed Codex bodies; Codex WebSocket requests are not retried.

## Codex catalog discovery

For `openai-codex`, support comes from the account's model catalog (`/backend-api/codex/models`, asked as originator `pi`, because the catalog is tailored per client), then the documented list. Discovery uses Pi's credentials, contacts **only official Codex endpoints**, rejects credentialed redirects, and forwards only authorization/account headers. Catalogs are memory-only; only model ids and tier decisions are kept. `PI_OFFLINE=1` disables discovery. The catalog query (`client_version=0.170.0`, originator `pi`) has not been checked against a live account.

## State

The preference is shared by Pi processes using the same agent directory:

```json
// ~/.pi/agent/fast-mode.json
{ "version": 1, "enabled": true, "ultrafast": true }
```

`ultrafast` is optional, so older versions of this extension still read the file (as Fast). Writes use an inter-process lock and atomic private replacement; requests reread authoritative state and idle sessions watch for changes. Invalid state is an error, not "off": eligible requests fail rather than silently dropping the policy. Repair the file or move it aside:

```bash
mv ~/.pi/agent/fast-mode.json ~/.pi/agent/fast-mode.json.bad
```

## Codex proxies: explicit opt-in

For a trusted Codex-compatible proxy such as CLIProxyAPI, create `~/.pi/agent/fast-mode-proxies.json`:

```json
{
  "version": 1,
  "routes": [{ "provider": "local-codex", "baseUrl": "http://127.0.0.1:8317/v1" }]
}
```

Provider, `openai-responses` API and normalized endpoint must match exactly. Routes load at session start/reload. Invalid configuration shows `speed !` and installs nothing. SDK embeddings may pass `proxyRoutes` to `createFastModeExtension`; an empty array disables opt-in.

## Diagnostics

`/fast status` shows the newest request's model, requested tier, whether this extension set it, any fallback, HTTP status, the provider-reported tier (OpenAI `service_tier`, Anthropic `usage.speed`, read from stream events on SSE and WebSocket), and output/completion timing. Records are bounded, session-local, and contain no prompts, auth or response text. A reported tier is provider evidence, not billing verification.

Pi's own cost estimate applies its priority multiplier for Fast on OpenAI routes; it has no Ultrafast or Claude Fast rate, so those estimates are low.

## Development

```bash
nix develop -c bun run --filter pi-fast-mode check
```

Tests use fake credentials and Pi's real OpenAI, Codex and Anthropic serializers with fake `fetch`, never paid calls. [`runtime.ts`](runtime.ts) uses Pi internals so the policy also reaches child runtimes; future Pi versions may need adaptation.

References: [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Claude fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode), Codex [model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs).
