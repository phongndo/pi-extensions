# Pi Fast Mode

A global Codex Fast-mode preference with a minimal native footer status, capability discovery, and private request diagnostics. Requires Pi **0.85.1 or newer**; tested against 0.85.1.

Fast mode requests `service_tier: "priority"` for eligible native `openai-codex` / `openai-codex-responses` calls and explicitly opted-in Codex proxies using `openai-responses`. It **does not lower reasoning, change models, or promise a speedup**. The preference is global across Pi processes sharing the same agent directory and defaults to off.

> If your saved preference is already on, this version starts requesting priority for **GPT-6 Astra** after reload. OpenAI documents Astra Fast mode at **2.5× Standard credit consumption**, where available. Check your account terms. [Codex speed and pricing](https://developers.openai.com/codex/speed)

## Commands

| Command         | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `/fast`         | Toggle the global preference                                                  |
| `/fast on`      | Enable; repeated calls do not rewrite unchanged state                         |
| `/fast off`     | Disable; repeated calls do not rewrite unchanged state                        |
| `/fast status`  | Read-only diagnostics: preference, model support, discovery, and last request |
| `/fast refresh` | Refresh model capabilities, then show on/off; does not write the preference   |

Toggle, on/off, and refresh commands reply only **`Fast mode on`** or **`Fast mode off`**. Startup is quiet; errors are still reported. Detailed output appears only when explicitly requested with `/fast status`.

After installing/updating, run **`/reload`**, then `/fast status`.

## Native footer status

Uses Pi's public `ctx.ui.setStatus` API: **`speed fast`** when enabled and supported; hidden when off. Uncertain support/state shows `speed ?`, unsupported models show `speed unavailable`, and state/policy failures show `speed !`.

Pi lays this out alongside other extension statuses. No model-line decoration, prototype patch, or custom-footer replacement. Status updates while idle and clears on shutdown/reload. RPC receives the same minimal labels; headless modes publish no UI.

### Detailed status (`/fast status`)

| Status                                 | Meaning                                                |
| -------------------------------------- | ------------------------------------------------------ |
| `fast on`                              | Preference on; eligible requests will request priority |
| `fast off`                             | This extension is not requesting priority              |
| `fast on · unavailable for this model` | Preference on, but the selected model is unsupported   |
| `fast on · support unknown`            | No usable capability metadata or documented fallback   |
| `fast unknown`                         | State has not been read yet                            |
| `fast error`                           | State/policy is unavailable; inspect `/fast status`    |

**On is a preference, not proof of backend admission.** Changing it affects subsequent requests, not one already sent. Off leaves another caller's explicit `service_tier` unchanged; it is not a guarantee that the provider uses Standard routing.

## Capability discovery

One resolver supplies both the UI and request policy, in this order:

1. Explicit `service_tiers` / legacy `additional_speed_tiers` metadata on a model (for SDK/native-provider integrations).
2. A fresh, matching account/endpoint capability catalog.
3. A maintained, documented fallback for exact model IDs:
   - `gpt-5.4`, `gpt-5.5`, `gpt-5.6`
   - `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
   - `gpt-6-astra`

Metadata can enable a newly advertised model or explicitly exclude a fallback model. Missing metadata allows the fallback; malformed metadata is **unknown**, not automatic support. Unknown future names are never enabled by a broad regex. Codex-Spark is a separate model, not Fast mode.

### Discovery behavior and privacy

Pi 0.85.1 does not expose service-tier capabilities in its public `Model` interface. The extension therefore provides a small metadata adapter:

- Discovery runs in the background at session start, model selection, and before an agent run; `/fast refresh` explicitly waits for a refresh.
- It resolves credentials through Pi's public model registry and performs a bounded GET to `https://chatgpt.com/backend-api/codex/models?client_version=0.85.1` (the tested Pi client version).
- It only probes official Codex base URLs. **Custom endpoints are never probed, and credentialed redirects are rejected.** Caller auth/base-URL overrides are respected.
- Only authorization and account-routing headers are forwarded; unrelated headers are not sent to discovery.
- Catalogs are memory-only, credential/account-scoped, and cached for 15 minutes. Failed discovery is retried no more than once per minute unless explicitly refreshed.
- Discovery has a five-second session-level deadline and a 4 MiB response bound. Shutdown/reload cancels it and invalidates late results.
- Only model IDs and normalized capability decisions are retained. Catalog instructions, prompts, credentials, and response bodies are never persisted or logged.
- `PI_OFFLINE=1` disables discovery. `/fast status` does not refresh credentials or fetch a catalog.

Discovery is **never performed inside the request payload hook**. Until metadata arrives, requests use the documented fallback or remain unchanged if support is unknown. A fallback is not proof of account entitlement. Failures are explained by `/fast status`; they do not disable an otherwise documented model.

This adapter does not alter Pi's model picker, model catalog, authentication, reasoning capabilities, or generated model definitions. Future Pi versions exposing native metadata can feed the same resolver without replacing the rest of the extension.

## Request diagnostics

`/fast status` includes the newest observed request from this extension instance (including inherited child-runtime calls):

- model and timestamp;
- requested tier, and whether Fast mode set it;
- configured transport, observed SSE transport, and HTTP status when exposed;
- **raw reported response tier**, if observed;
- first observed output and provider-completion milliseconds, when available.

A bounded session-local journal retains at most ten minimal records. It contains **no prompt text, tool arguments, response text, auth, or full headers**. It is not written to disk and is cleared with the extension instance on reload. Concurrent requests keep their own observations; a late older completion does not replace the newest request.

### Important limitations

- **SSE:** a bounded, backpressure-aware stream tap reads raw tier metadata and passes response bytes through unchanged, including cancellation and errors. Oversized/malformed frames are ignored by diagnostics, not modified for Pi.
- **WebSocket:** Pi 0.85.1 does not expose raw response-tier metadata to extensions. Its tier remains **unknown** here; the extension does not patch global WebSocket objects or force SSE just to obtain telemetry. Existing connection reuse, cached continuation, and fallback remain intact.
- HTTP success and Pi's dollar estimate are **not** admission confirmation. Pi's Codex pricing code can substitute the requested priority tier even when the raw response reports `default`.
- A reported tier is displayed literally as provider evidence, not independent verification of actual admission or billing. Missing evidence stays unknown.
- Timing measures provider requests, not total coding-task/tool time. First output includes observable text/reasoning-summary/tool-argument deltas, not hidden reasoning computation.

For a real speed comparison, hold model, reasoning, task, context, and transport constant and alternate Standard/Fast runs with an explicit spending budget. No paid benchmark runs automatically.

## Global persistence and synchronization

Default state path:

```text
~/.pi/agent/fast-mode.json
```

A custom Pi agent directory moves the path with it. Existing version-1 state remains compatible:

```json
{
  "version": 1,
  "enabled": false
}
```

Changes use the existing recoverable inter-process lock and atomic private file writes. Explicit on/off commands share the toggle's lock and skip unchanged writes. Every eligible request rereads authoritative state.

Idle TUI/RPC sessions watch the **parent directory**, so atomic file replacements remain visible. A one-second polling fallback handles unavailable/missed watcher events. Reads are generation-checked so an old read cannot overwrite a newer UI state. Watchers, polling, and pending UI updates are cleaned up on shutdown/reload. Print/JSON sessions do not start UI polling.

Invalid state is not mislabeled as off. Eligible requests fail on a state-read error rather than silently dropping the policy. Repair the file or move it aside; a missing file defaults to off:

```bash
mv ~/.pi/agent/fast-mode.json ~/.pi/agent/fast-mode.json.bad
```

## Codex proxies (explicit opt-in)

To use `/fast` with CLIProxyAPI while keeping its account pooling, create `~/.pi/agent/fast-mode-proxies.json`:

```json
{
  "version": 1,
  "routes": [
    {
      "provider": "local-codex",
      "baseUrl": "http://127.0.0.1:8317/v1"
    }
  ]
}
```

Then run **`/reload`**, followed by `/fast on` and `/fast status`. If your global preference is already on, opting in starts requesting priority after reload. This can increase credit consumption; it does not prove that an upstream account admits the request to Fast mode.

- Only the exact provider, the `openai-responses` API, and the normalized endpoint match. Trailing URL slashes are ignored; different hosts (including `localhost` versus `127.0.0.1`), ports, schemes and paths are separate routes. Runtime-resolved endpoint changes are checked on the actual request model.
- The same metadata and exact-model fallback rules apply. Unknown model names/aliases are not automatically enabled just because their proxy is opted in.
- `/fast off` stops this extension from setting priority. Remove any static `samplingParams.service_tier` or proxy-side override if you want this toggle to be the sole owner; off intentionally preserves another caller's explicit tier.
- Proxy credentials are never used for capability discovery, and the extension does not query upstream accounts or alter pool selection. `/fast status` identifies the opted-in route as a proxy and reports requested versus raw response tiers separately. A response reporting `default` is not proof that Fast was ignored. See the [upstream explanation](https://github.com/router-for-me/CLIProxyAPI/issues/5772#issuecomment-5647673503).
- The file is optional; without it, behavior stays native-Codex-only. An invalid file shows `speed !` and installs no policy decorators. Fix it and `/reload`.
- Routes are snapshotted at session start/reload, **not** hot-reloaded by `/fast refresh`. After editing/removing the file, reload every affected Pi session. No network requests or credential resolution occur when reading it.
- The file lives beside `fast-mode.json`, including with a custom agent directory or SDK `statePath`. SDK embeddings may instead pass `proxyRoutes: [{ provider, baseUrl }]` to `createFastModeExtension`; an explicit empty array disables proxy opt-in for that instance.

Use only trusted Codex-compatible proxy routes. Opt-in requests the `priority` wire value; it does not add an account entitlement or guarantee a speedup. The file contains no credentials.

## Child runtimes and compatibility

Native Codex and opted-in proxy providers share the same global on/off policy. There are no account-pool event listeners or model-route aliases.

Provider lookup and active-runtime stream decorators retain the global policy when provider objects/authentication are transferred into isolated child runtimes. They compose with existing payload hooks, catalog refreshes, immutable providers, and out-of-order teardown. Unsupported providers/APIs and mismatched payload models remain untouched.

`runtime.ts` uses Pi internals to cover both host and child requests. Tested on Pi 0.85.1; required methods are checked before installation, but future versions may need updates. The existing file-lock protocol remains compatible with already-running sessions.

## Development

```bash
bun run --filter pi-fast-mode check
bun run --filter pi-fast-mode format
```

Tests use fake credentials and synthetic responses, not paid model calls. Coverage includes opt-in proxy request serialization and child inheritance, route/API/model isolation, resolved endpoint overrides, route reload and validation, proxy discovery exclusion, Astra, positive/negative/unknown capabilities, credential-scoped catalog caching, stale-response races, actual Codex SSE serialization, response-tier diagnostics, the real Pi loader/footer, commands, cross-session synchronization, atomic persistence, and child/runtime refresh behavior.

The discovery protocol follows [Codex's ModelsClient](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs); capability checks follow [Codex model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs).
