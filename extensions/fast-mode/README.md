# Pi Fast Mode

A global preference that requests `service_tier: "priority"` for eligible native Codex calls and explicitly opted-in Codex proxies. Requires Pi **0.85.1+**; compatibility tests target 0.85.1.

Fast mode **does not change models or reasoning effort, establish account entitlement, or guarantee a speedup**. It can increase charges; check [current Codex speed and pricing](https://developers.openai.com/codex/speed). A saved on preference also applies to supported GPT-6 Astra, Luna, and Sol models.

## Use it

| Command         | Effect                                                                |
| --------------- | --------------------------------------------------------------------- |
| `/fast`         | Toggle the global preference                                          |
| `/fast on`      | Enable                                                                |
| `/fast off`     | Disable                                                               |
| `/fast status`  | Inspect preference, support, discovery, and the last observed request |
| `/fast refresh` | Refresh model capabilities without changing the preference            |

After installation or updates, run `/reload`, then `/fast status`. Startup is quiet. Toggle, on/off, and refresh reply only `Fast mode on` or `Fast mode off`; errors are still reported.

The native footer shows `speed fast` when enabled and supported, `speed ?` for uncertainty, `speed unavailable` for unsupported models, and `speed !` for state/policy failures. It is hidden when off. RPC receives the labels; print/JSON sessions have no status UI.

**On is a preference, not proof of backend admission.** Changes affect subsequent requests, not an in-flight request. Off leaves another caller's explicit `service_tier` untouched; remove static overrides if you want this toggle to be the only owner.

## Model support and discovery

Support is resolved from explicit model metadata, then a fresh account/endpoint catalog, then an exact-model fallback. Metadata can exclude fallback models; malformed metadata means unknown support. Unknown future names and aliases are not enabled by a broad name match. The maintained fallback IDs live in [`capabilities.ts`](capabilities.ts).

Discovery uses Pi's model-registry credentials and probes **only official Codex endpoints**. It rejects credentialed redirects and forwards only authorization/account-routing headers. Custom proxy credentials are never used for discovery.

Catalogs are memory-only and account-scoped. Only model IDs and capability decisions are retained, not credentials, server instructions, or response bodies. Discovery runs in the background at session start, model selection, and before an agent run. `/fast refresh` waits for it; `/fast status` does not fetch or refresh credentials. Set `PI_OFFLINE=1` to disable discovery.

Until discovery succeeds, the resolver uses the documented fallback or leaves unknown models unchanged. A fallback does not establish entitlement. Discovery failures appear in `/fast status`.

## State and recovery

The preference defaults to off and is shared by Pi processes using the same agent directory:

```text
~/.pi/agent/fast-mode.json
```

```json
{
  "version": 1,
  "enabled": false
}
```

A custom agent directory moves this path. Writes use an inter-process lock and atomic private replacement; requests reread authoritative state, and idle TUI/RPC sessions watch for changes.

Invalid state is an error, not “off.” Eligible requests fail on a state-read error rather than silently dropping the policy. Repair the file, or move it aside to restore the missing-file default:

```bash
mv ~/.pi/agent/fast-mode.json ~/.pi/agent/fast-mode.json.bad
```

Adjust that path if using a custom agent directory, and preserve any existing backup.

## Codex proxies: explicit opt-in

For a trusted Codex-compatible proxy such as CLIProxyAPI, create `~/.pi/agent/fast-mode-proxies.json`:

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

Run `/reload`, then `/fast on` and `/fast status`. If the preference was already on, opt-in begins requesting priority after reload and can increase credit consumption.

- The provider, `openai-responses` API, and normalized endpoint must match. Trailing slashes are ignored; hosts, ports, schemes, and paths remain distinct, including `localhost` versus `127.0.0.1`.
- The same metadata and exact-model fallback rules apply. Opt-in does not enable unknown aliases, probe upstream accounts, or alter account-pool selection.
- Routes load at session start/reload. After editing or removing this file, reload every affected session; `/fast refresh` does not reload routes.
- Without the file, only native Codex is eligible. Invalid route configuration shows `speed !` and installs no policy decorators.
- The file contains no credentials and lives beside `fast-mode.json`. SDK embeddings may pass `proxyRoutes` to `createFastModeExtension`; an explicit empty array disables opt-in for that instance.

## Interpret diagnostics

`/fast status` shows the newest request's model, timestamp, requested tier, whether this extension set it, transport, HTTP status, raw reported tier, and observed output/completion timing when available. Records are bounded, session-local, and cleared on reload. They contain no prompts, tool arguments, response text, auth, or full headers.

Raw response-tier metadata is observed for SSE; it remains unknown for WebSocket on the tested Pi version. The extension neither forces SSE nor patches global WebSocket objects. HTTP success and Pi's cost estimate are not admission confirmation. A raw tier is provider evidence, not independent billing verification; missing evidence stays unknown. For proxy-specific interpretation, consult the proxy's current documentation.

Timing covers provider requests, not total task/tool time. A useful speed comparison holds model, reasoning, task, context, and transport constant and alternates Standard/Fast runs under an explicit spending budget. No paid benchmark runs automatically.

## Development and compatibility

From the repository root:

```bash
nix develop -c bun run --filter pi-fast-mode check
```

Tests use fake credentials and synthetic responses, not paid model calls. [`runtime.ts`](runtime.ts) uses Pi internals to preserve the policy across host and child runtimes; future Pi versions may require adaptation. Required methods are checked before installation. Unsupported providers/APIs and mismatched payload models remain untouched.

For discovery-protocol work, consult upstream [ModelsClient](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs) and [model metadata](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs).
