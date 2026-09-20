# Pi MCP

Connect configured MCP servers to Pi and toggle them with `/mcp`. Requires Pi **0.85.1+**; compatibility tests target 0.85.1.

## Connect a server

Servers are read from these files, in order; later entries override earlier ones by server name:

1. `~/.config/mcp/mcp.json` — shared user configuration
2. `~/.pi/agent/mcp.json` — Pi overlay and enable/disable preferences

Example shared configuration:

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

`${ENV_VAR}` expands in strings. Use `url` for HTTP, `"type": "sse"` or a URL ending in `/sse` for SSE, and `command` for stdio. A `{ "disabled": true }` overlay preserves the original connection definition. An overlay containing `url`, `command`, `headers`, or `env` replaces those fields instead of inheriting secrets.

Project `.mcp.json` and `.pi/mcp.json` are deliberately ignored: they would otherwise allow processes or credentialed connections before Pi's project-trust prompt. Configure only trusted servers in the user files.

Run `/mcp`, select a server, and press Enter/Space to enable or disable it; Esc closes the menu. Enabled servers connect at session start. Toggling writes only preferences to the Pi overlay, not a copy of shared credentials.

## Connection and tool behavior

- Enabling connects and registers `mcp__<server>__<tool>` tools immediately. Disabling disconnects and removes them. Names over 64 characters receive a stable shortened form.
- The selected menu row shows connection state, tool count, and an approximate tool-definition token cost; multiple enabled servers also show a combined total.
- The footer shows `mcp connected/total`, counting servers, including disabled or failed servers in the denominator. No servers means no label. This is transport state, not a health probe.
- RPC uses select prompts and receives footer status. Print/JSON sessions connect tools without UI.
- Tool results preserve model-facing content and images. The TUI shows compact previews; expand for arguments and full text. Text over **2,000 lines or 50 KiB** is saved to a private temporary file whose path remains visible.
- Calls execute sequentially. Cancellation is forwarded to the SDK; tool errors remain errors. Stdio server logs are drained without printing over Pi's UI or protocol stream.

## Reconnect and troubleshoot

Toggle a server off/on or run `/reload` to reconnect and refresh tool discovery. There is no automatic reconnect or heartbeat; a failure without a transport-close notification may appear connected until another operation detects it.

Tools are discovered on connection. Live tool-list-change notifications, prompts/resources browsing, OAuth login, sampling, and elicitation are not implemented.

Other Pi sessions must reload to pick up overlay changes. Writes are atomic and locked across cooperating processes, but external editors and older versions can still race.

## Firecrawl through Executor

For web access, add the [official Firecrawl MCP server](https://docs.firecrawl.dev/mcp-server) as a remote integration in Executor at `https://mcp.firecrawl.dev/v2/mcp`:

1. Configure API-key authentication with header `Authorization` and prefix `Bearer `, including the trailing space. Add this explicitly if discovery selects no authentication.
2. Enter the raw key in Executor's secure credential field, not the prefix, URL, or agent chat.
3. Enable Executor in `/mcp`, or reconnect it to refresh discovery.

Executor owns this credential; the extension does not import Pi-stored Firecrawl keys or `FIRECRAWL_API_KEY`, and provides no `/login firecrawl`. Keyless access has a limited catalog. Consult the upstream docs for current capabilities and account limits. Browser actions and recurring jobs require deliberate authorization, and provider charges still apply.

## Development

From the repository root:

```bash
nix develop -c bun run --filter pi-mcp check
```

Normal checks use local fixtures without real MCP credentials or configured servers. The opt-in executor test uses a real configured connection:

```bash
nix develop -c env PI_MCP_LIVE_TEST=1 bun run --filter pi-mcp test
```
