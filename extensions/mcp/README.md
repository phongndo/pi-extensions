# Pi MCP

A small native `/mcp` menu for Pi. It connects the current session to MCP servers you already configured for other agents, and lets you enable or disable those servers the same way `/settings` toggles options.

Pi does not ship MCP in core. This extension is the missing command: one slash command, a bordered settings list, and tools registered only while a server is enabled.

## Behavior

- `/mcp` replaces the editor with a native settings list, matching `/settings`: accent title, dynamic borders, `→` cursor, Enter/Space to change, Esc to close.
- Each configured server is a row. The value is `enabled` or `disabled`. The selected row's description shows `connected`, `connecting`, `failed`, or `disconnected`, plus tool count or the connection error.
- Enabling a server connects it immediately and adds its tools to the current session. Disabling disconnects it and removes those tools from the active set.
- Enabled servers also connect on `session_start`, so executor is available without opening the menu.
- Project MCP files load only after the project is trusted.
- The menu writes enable/disable state to Pi's overlay file. It does not copy URLs, headers, or other secrets out of the shared config.

RPC sessions can still use `/mcp`: pick a server, then enable or disable it. Print and JSON modes print a one-line status list.

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

Disable a server from `/mcp` to drop its tools from the model without a reload.

## Command

```text
/mcp
```

The command takes no arguments. Use the menu to enable or disable servers.

## Development

```bash
pnpm --filter pi-mcp check
```

After editing, run `/reload` in Pi. Tests cover config merge, overlay writes, tool naming, result formatting, the settings rows, and a live executor round-trip when `~/.config/mcp/mcp.json` points at a running executor.
