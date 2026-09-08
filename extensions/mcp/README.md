# Pi MCP

A small native `/mcp` menu for Pi. It connects the current session to MCP servers you already configured for other agents, and lets you enable or disable those servers the same way `/settings` toggles options.

Pi does not ship MCP in core. This extension adds one slash command, a native settings list, Pi-registered tools, and a minimal native footer connection count. Requires Pi **0.85.1 or newer**; tested against 0.85.1.

## Behavior

- `/mcp` replaces the editor with the same bordered settings list as `/settings`: a `>` search field, `→` cursor, Enter/Space to change, Esc to close.
- Each configured server is a row. The value is `enabled` or `disabled`. The selected row's description shows connection state, tool count, and an estimate of tool-definition tokens (~4 characters per token) that those MCP tools add to context. When more than one server is enabled, it also shows the combined enabled total.
- Enabling a server connects it immediately and adds its tools to the current session. Disabling disconnects it and removes those tools from the active set.
- Enabled servers also connect on `session_start`, so executor is available without opening the menu.
- The menu writes enable/disable state to Pi's overlay file. It does not copy URLs, headers, or other secrets out of the shared config.
- Pi's native footer status API shows **`mcp connected/total`** alongside other extension statuses, with no startup banner. The menu and count update as clients connect, fail, disconnect, or are toggled.

RPC sessions can still use `/mcp`: pick a server, then enable or disable it. RPC also receives the count through Pi's native status API. Print and JSON sessions connect tools but do not install a panel or emit status UI.

## Native footer count

```text
ctxt recall · speed fast · mcp 1/2
```

`mcp 1/2` means one connected server out of two configured servers. Disabled, connecting, and failed servers remain in the denominator but not the numerator. This counts **servers**, not the tools or integrations exposed by an executor server.

No configured servers means no label. Uses the public `ctx.ui.setStatus` API; Pi owns layout and truncation. The extension never patches or replaces the footer. Connection status is session-local and based on the SDK's known transport state, not a background health check. Subscriptions and this extension's status are cleared on shutdown/reload.

## Configuration

Servers are merged in this order. Later files override earlier ones by server name. A `{ "disabled": true }` overlay keeps the original URL; a later definition that includes `url`, `command`, `headers`, or `env` replaces those fields instead of inheriting secrets.

1. `~/.config/mcp/mcp.json` — shared user config used by other agents
2. `~/.pi/agent/mcp.json` — Pi overlay (enable/disable, or a full server replacement)

Project `.mcp.json` and `.pi/mcp.json` files are not loaded. Pi's project-trust prompt does not run for those files alone, so auto-connecting them would spawn processes or send credentials before `/mcp`. Put servers in the shared user config instead.

`${ENV_VAR}` is expanded in strings. A server is HTTP when it has `url` (or `"type": "http"`), SSE when `"type": "sse"` or the URL path ends in `/sse`, and stdio when it has `command`.

Example shared config for executor:

```json
{
  "mcpServers": {
    "executor": {
      "type": "http",
      "url": "http://localhost:4789/mcp?artifacts=false&search_tools=true",
      "headers": {
        "Authorization": "Bearer ${EXECUTOR_TOKEN}"
      }
    }
  }
}
```

If executor is already in `~/.config/mcp/mcp.json`, this extension uses that entry as-is.

## Tools

Connected servers register tools as `mcp__<server>__<tool>`. Executor therefore appears as `mcp__executor__execute`, `mcp__executor__resume`, `mcp__executor__skills`, and the `search_*` loaders the server exposes. Tool calls are sequential and read the live client at call time, so a reconnect does not leave a closed transport in a closure.

Disable a server from `/mcp` to drop its tools from the model without a reload. Closed transports also deactivate their tools. Re-enabling refreshes descriptions and schemas, including paginated tool lists.

Tool rows keep Pi's native shell, expand/collapse controls, theme colors, and image display. Headers show `server / tool` with a short argument preview. Collapsed results show up to four preview lines; JSON becomes readable field/item summaries instead of a dense blob. Expand to see all arguments and returned text, with JSON indented. Full-output paths remain visible even when collapsed. This is display-only: model-facing content and image blocks are unchanged.

Text is limited to Pi's standard **2,000 lines or 50 KiB**; larger responses are saved to a private temporary file with a path for follow-up reads. Tool errors remain errors, and request cancellation is forwarded to the MCP SDK. Stdio server logs are drained rather than printed over the TUI or RPC/JSON stream.

## Command

```text
/mcp
```

The command takes no arguments. Use the menu to enable or disable servers.

## Development

```bash
pnpm --filter pi-mcp check
```

After editing, run `/reload` in Pi. Tests cover the native settings menu and result renderer, live counts, Fast Mode composition and teardown, concurrent overlay writes, stale lifecycle work, output limits, and a local SDK-backed stdio fixture. Normal checks do not read real MCP credentials or call configured servers.

An optional live executor check is available with `PI_MCP_LIVE_TEST=1 pnpm --filter pi-mcp test`.

### Scope and remaining limitations

- No automatic reconnect or heartbeat; toggle off/on or `/reload` to reconnect. Transport failures not reported as a close may remain connected until a subsequent operation detects them.
- Tools are discovered on connection; live tool-list-change notifications, MCP prompts/resources browsing, OAuth login, sampling, and elicitation are not implemented.
- Overlay mutations are serialized within a Pi process using Pi's file-mutation queue. Separate Pi processes are not inter-process locked or automatically synchronized.

See [the implementation review](../../docs/mcp-review.md) for the audit findings and regression coverage.
