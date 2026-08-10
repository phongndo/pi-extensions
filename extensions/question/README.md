# Pi Question

A small, native interactive clarification tool for Pi. The model can call `question` during an ordinary agent run, Pi pauses that tool call for the user's response, and the same run resumes with a compact answer result.

## Behavior

- Available as the `question` tool in normal interactive chat; it is not tied to plan mode.
- Uses Pi's native `SelectList` and chat editor, including configured select/cancel keybindings.
- Supports one to four related questions per call and up to six options per question.
- Keeps every question in one layered dialog, with answers preserved while navigating layers.
- Supports single choice, multiple choice, and wrapped multi-line free-text answers.
- Follows Codex's request-user-input flow: Enter or a number submits a single choice, Space marks it without advancing, and Tab opens notes for that choice.
- Adds “None of the above” as the final option; its note can stand alone as the answer.
- Lets notes supplement any selected option and wraps them below the option list without extra indentation or another pane.
- Shows no empty circle markers; marked answers receive a trailing `✓`.
- Expands the option-label column to avoid cutting readable choices off at the native 32-column default.
- Uses a compact native chat editor without the stock shortcut footer.
- Supports `j`/`k` option navigation and `h`/`l` or left/right question-layer navigation.
- Uses Ctrl+P/Ctrl+N to switch question layers while editing free text or notes.
- Executes sequentially so sibling tool calls do not run past a clarification prompt.
- Waits without a default timeout.
- Returns cancellation as a normal tool result, allowing the model to recover.
- Returns immediately with an unavailable result in print and JSON modes instead of hanging.

Pi RPC mode uses the same dialog calls through Pi's extension UI protocol.

## Tool input

```json
{
  "questions": [
    {
      "id": "database",
      "question": "Which database should I use?",
      "options": [
        {
          "label": "PostgreSQL",
          "description": "Best fit for production workloads"
        },
        {
          "label": "SQLite",
          "description": "Simplest local deployment"
        }
      ]
    },
    {
      "id": "checks",
      "question": "Which checks should I run?",
      "options": [{ "label": "Unit tests" }, { "label": "Integration tests" }, { "label": "Lint" }],
      "multiple": true
    },
    {
      "id": "notes",
      "question": "Any additional constraints?"
    }
  ]
}
```

Omit `options` for free text. Use two to four choices normally; the hard cap is six. Batch related questions in one call when multiple answers are needed. The TUI adds “None of the above” automatically, so models should not add an `Other` option. Enter or a displayed number submits a single choice immediately. Press Space first to mark a choice without advancing, then Tab to add notes; Enter submits the choice and note together. Notes attached to “None of the above” become a standalone answer. Navigate question layers with `h`/`l` or left/right while choosing, and Ctrl+P/Ctrl+N while editing.

## Tool result

Only the compact answer map is sent back to the model:

```json
{
  "database": ["PostgreSQL", "user_note: Keep the existing schema"],
  "checks": ["Unit tests", "Lint"],
  "notes": ["Keep the existing API compatible"]
}
```

The original questions and richer state remain in tool-result `details` for Pi's transcript renderer and session reconstruction. They are not repeated in model-facing result text.

Cancellation is represented as:

```json
{ "cancelled": true }
```

## Context efficiency

The tool keeps its recurring prompt cost small:

- One short tool description, one-line tool snippet, and focused system-prompt guideline
- The guideline encourages proactive clarification while discouraging questions about discoverable facts or trivial choices
- A six-option ceiling for flexibility, while prompting models to prefer two to four
- No duplicated headers or option values
- Short answer IDs rather than question text as result keys
- No prose wrapper around answers
- Full display state kept in `details`, not model-facing `content`

The model is instructed to use `question` proactively when clarification would improve the result, prefer a brief question over a consequential assumption, and batch related questions in one call.

## Prompt caching

Calling `question` does not change Pi's active tools, system prompt, or provider-visible tool definitions. The answer is an ordinary tool result, so repeated calls preserve the existing prompt prefix.

OpenAI requires tool definitions and their ordering to remain identical for a cache hit. Adding `question`, or changing its name, description, snippet, guideline, or JSON schema during `/reload`, therefore causes one expected cache miss in the current session. UI and execution code live separately in `ui.ts` so visual changes can be reloaded without changing that provider-visible contract. A focused test snapshots the contract fingerprint to make accidental cache-busting changes explicit.

For extension development, load contract changes before a session becomes large or use a short test session. At runtime, `question` itself does not invalidate the cache.

## Development

```bash
pnpm --filter pi-question check
```
