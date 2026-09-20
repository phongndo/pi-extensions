# Pi Question

The `question` tool pauses an agent run for clarification, then resumes it with a compact answer map. It works in ordinary chat, without plan mode or configuration.

## Answering questions

The TUI presents up to four related questions in one layered dialog, preserving drafts while you navigate:

- Enter or a displayed number submits a single choice. For multiple choice, Space marks options and Enter submits.
- To add a note to a single choice, mark it with Space, then press Tab. Enter submits the choice and note together.
- “None of the above” accepts a standalone answer through its note field.
- Use `j`/`k` to navigate options, `h`/`l` or left/right to switch question layers, and Ctrl+P/Ctrl+N to switch layers while editing text.
- Editing a submitted answer requires Enter to reconfirm. Pi's configured select/cancel keybindings are respected.

There is no default timeout. Cancellation returns `{ "cancelled": true }`. RPC uses native select/editor prompts; print and JSON modes return an unavailable result rather than waiting for input.

## Calling the tool

Call `question` when user input about intent, scope, preferences, constraints, or tradeoffs is needed before continuing. Discoverable facts and trivial choices do not need clarification. Batch related questions in one call.

```json
{
  "questions": [
    {
      "id": "database",
      "question": "Which database should I use?",
      "options": [
        { "label": "PostgreSQL", "description": "Shared production database" },
        { "label": "SQLite", "description": "Local single-file storage" }
      ]
    },
    {
      "id": "platforms",
      "question": "Which platforms must this support?",
      "options": [{ "label": "macOS" }, { "label": "Linux" }],
      "multiple": true
    },
    {
      "id": "notes",
      "question": "Any additional constraints?"
    }
  ]
}
```

Omit `options` for free text. Prefer two to four choices; the hard cap is six. The TUI adds “None of the above,” so do not add an `Other` option. Calls execute sequentially so sibling tool calls cannot run past a clarification.

The model receives only the answer map:

```json
{
  "database": ["PostgreSQL", "user_note: Keep the existing schema"],
  "platforms": ["macOS", "Linux"],
  "notes": ["Keep the existing API compatible"]
}
```

TUI notes use the `user_note: ` prefix; RPC custom answers and free text remain plain strings. Original questions and richer display state stay in tool-result `details` for transcript rendering and session reconstruction.

## Development

From the repository root:

```bash
nix develop -c bun run --filter pi-question check
```

Tool calls do not change the system prompt or tool definitions. Changing the tool contract during `/reload` changes the prompt prefix and can invalidate provider caching; make those changes in a short test session. UI-only changes live in `ui.ts`. The contract-fingerprint test in [`tests/question.test.ts`](tests/question.test.ts) guards accidental definition changes.
