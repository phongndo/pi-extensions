# Pi Advisor

Pair the model you work with (the executor) with a stronger advisor model. The executor calls the zero-parameter `advisor` tool; the extension forwards its system prompt, active tools, and full transcript to the advisor model and returns the advice as the tool result. Any model Pi can reach works as either side.

## Choosing the advisor

```text
/advisor                                   open the picker
/advisor anthropic/claude-opus-5-5:high    set directly; a bare model id works when unambiguous
/advisor opus                              no exact match: open the picker filtered by "opus"
/advisor speed fast                        set advisor speed: inherit, standard, fast, ultrafast
/advisor status                            show the advisor and its last observed speed
/advisor off                               disable it
```

The picker works like `/model`: type to fuzzy-search, ↑/↓ and Page Up/Down to move, Enter to select, Esc to cancel, and Tab to switch between all and scoped models when the session has scoped models. Shift+Tab cycles the advisor's thinking level, which is clamped to what the selected model supports and defaults to `high`. The current advisor is listed first and marked ✓; the `off` row disables it.

With the Fast Mode extension loaded, Ctrl+G cycles the selected model's speed preference. **Inherit** (the default) follows the global `/fast` or `/ultrafast` setting where the advisor model supports it. Direct Anthropic Fable 5.2 stays at Standard with Inherit; choose `/advisor speed fast` explicitly to opt in. **Standard** avoids requesting Fast for that advisor even when the executor is using it. The picker always offers Standard and marks unknown premium-tier support with `?`. Listed support is not confirmation that your account has access. If a chosen speed isn't available, the request uses a lower speed without changing the model or thinking level. The result shows the requested speed, any retry at a lower speed, and the provider-reported tier when available. An explicit speed still respects pauses after a provider refusal; `/fast refresh` clears those pauses. Without Fast Mode, the speed preference has no effect.

The choice is global, saved in `~/.pi/agent/advisor.json`, and loaded when a session starts; other running sessions pick up a change after `/reload`. The `advisor` tool is active only while an advisor is configured. The footer shows `advisor (<model> • <thinking>)` and includes the speed preference when not inherited.

## What the advisor sees

- The executor's current system prompt and the names and descriptions of its active tools.
- The session's model-visible transcript after compaction and context edits: user messages, assistant text, unredacted thinking, tool calls with arguments, and full tool results. Images become `[image: type]` placeholders.
- Earlier advisor answers, labelled as `advisor` tool results, so it builds on its own advice.

When the transcript does not fit the advisor's context window, older tool output and thinking are shortened to their head and tail first, then the oldest turns are dropped (the first user message is kept), and the advisor is told that parts were omitted.

The advisor has no tools and cannot read files; it reasons only over what the executor has already seen. Pi streams the advisor's response to the UI, but the executor waits for the tool result before continuing. Unlike Claude's native server-side [advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#how-it-works), Pi runs the consultation as a separate model request.

## Cost

Each call sends the whole transcript to the advisor model. Calls in one session share a stable cache key, so providers with prompt caching reuse the unchanged prefix. The tool result shows the advisor's tokens, cost, and duration; these are not part of the executor's context usage.
