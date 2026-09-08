# MCP implementation review

Reviewed against the installed Pi **0.85.1** extension/TUI documentation, dynamic-tools and custom-footer examples, Pi's actual `FooterComponent` / `ToolExecutionComponent`, and the MCP SDK client implementation. This is a focused integration review, not a full security or MCP-protocol conformance audit.

## Native integration

- Tools are registered directly with `pi.registerTool()`, not routed through shell commands or a proxy LLM. Names remain `mcp__<server>__<tool>`.
- `pi.setActiveTools()` controls availability while preserving unrelated tools. Descriptions and schemas refresh on reconnect.
- `/mcp` uses Pi's `SettingsList`, `DynamicBorder`, standard settings theme, and `ctx.ui.custom()`. RPC uses native selectors and statuses.
- Tool results now defer to Pi's own collapsed/expanded renderer; image results remain native image blocks. Text uses Pi's standard truncation limits and private spill files. Errors are thrown as required by Pi's tool API, and abort signals reach the SDK.
- Clients start only from the session lifecycle, never from extension discovery. Shutdown aborts pending initialization, removes listeners, closes clients, and deactivates tools.

## Inline status

Updated by user request: MCP and Fast Mode now use Pi's public `ctx.ui.setStatus` API with minimal labels (`mcp connected/total`, `fast`). The former inline footer decorator has been removed; neither extension patches the model/stats line or replaces custom footers. Pi owns status layout and truncation. Total includes disabled and failed configured servers; the count is per Pi session, not a count of executor integrations or tools. No configured servers means no MCP label; Fast is hidden when off.

## Confirmed issues addressed

| Finding                                                                 | Change / regression coverage                                                                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom result renderer printed all output, bypassing Pi collapse/expand | Use Pi's real fallback renderer; test collapsed and expanded `ToolExecutionComponent` output                                                                     |
| Reconnect retained stale descriptions/schemas                           | Re-register current tool definitions; regression checks updated definitions                                                                                      |
| Closed clients stayed in the connected map                              | Subscribe to SDK closure; remove tools and update menu/footer immediately                                                                                        |
| Late failures and overlapping restart/shutdown could revive state       | Generation and lifetime guards; tests cover rejected/late connections and a restart blocked on old-client shutdown                                               |
| Different-server toggles raced on one overlay/temp file                 | Use Pi's file-mutation queue around read-modify-write, canonicalizing the parent before creating the file; parallel-write regression covers macOS `/var` aliases |
| MCP images became base64 JSON in model text                             | Preserve native image blocks; verify through a real local SDK fixture                                                                                            |
| Unbounded text could flood model context                                | Apply Pi's 2,000-line / 50-KiB limits, with private recoverable full-output files                                                                                |
| Stdio logs inherited the terminal                                       | Pipe and drain stderr; subprocess test asserts clean parent stderr/stdout                                                                                        |
| Only the first tool-list page was loaded                                | Follow bounded pagination and reject repeated cursors; test paginated SDK responses                                                                              |
| MCP's old Pi/Zod dependency combination created duplicate Pi instances  | Align Pi to 0.85.1 and remove the unused direct Zod dependency                                                                                                   |

## Boundaries left explicit

- Connected means the SDK session is known to be open. There is no heartbeat or automatic reconnection, and an unreachable idle HTTP server may not be detected immediately.
- Server tools are refreshed on reconnect, not via tool-list-change notifications. MCP prompts/resource browsing, OAuth login, sampling, and elicitation are outside the current bridge.
- Concurrent mutations in one Pi process are serialized. Independent Pi processes can still race on the shared overlay; external changes require reload to affect another session.
- Truncated full-output files intentionally survive session shutdown so their reported paths remain usable. They are temporary private files, not a persistent diagnostics journal.
- Inline placement depends on Pi's built-in footer shape. Actual footer tests cover light/dark themes, narrow widths, session isolation, and both Fast/MCP load and teardown orders.

## Validation

Normal checks use synthetic responses and local SDK-backed fixture processes, not real user credentials or configured services. The optional executor smoke test now requires `PI_MCP_LIVE_TEST=1`. Real user-terminal behavior still requires `/reload` and visual confirmation.
