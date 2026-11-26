# Tidy

A Codex-style transcript for Pi. Each tool call is a short block you can click to expand or collapse. Requires Pi 1.5.2 or later (tested on 1.6.1).

```
 › Run node test.js (it fails), fix the bug, and rerun it.

 The test fails on add; I'll check math.js.

 • Ran node test.js · exit 1
   └ node:internal/assert/utils:146
       throw error;
     … +6 lines (click or ctrl+o)
     Node.js v26.13.1

 • Explored
   └ Read test.js, math.js
     Search "add" · 4 matches

 • Edited math.js (+1 -1)
   └ 1 function add(a, b) {
     -2   return a - b;
     +2   return a + b;

 • Ran node test.js
   └ ok

 add subtracted instead of adding. I fixed math.js:2 and the test passes.
```

- **Blocks.** Each call is `• Verb target`, with its result under `└`. The dot is dim while running, green when done and red on failure. A failed command also says `exit N`.
- **Short by default.** Output keeps its first and last two lines around `… +N lines`. Diffs show their first 8 lines. Long or multi-line commands show their first line and `+N lines`.
- **Explored.** Reads, searches, finds and listings in a row share one `Explored` block, and reads of several files merge into one line.
- **Scripts.** A `codemode` block lists the calls its script made, one per line, and how many failed.
- **Other tools.** Advisor, question and MCP tools get the same block, with their own result under it, cut to 5 lines. Tools whose renderer draws its whole row itself (`renderShell: "self"`) keep it, and end a run of reads.
- **Click to expand.** Clicking a block toggles it open and closed. `ctrl+o` (`app.tools.expand`) toggles every block. Expanded blocks show the full command, output, diff, file contents or script.
- **Prompts and prose.** Your prompts start with `›`. The `Thinking...` placeholder lines are gone. A short `response-style` section in the system prompt asks for answer-first replies; your own formatting requests take precedence.

`/tidy off` turns all of this off, and `/tidy on` turns it back on. The setting is saved in `~/.pi/agent/tidy.json`. Blocks already on screen change after `/reload`.

## Sources

- Codex ([`exec_cell/render.rs`](https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs)): the `•` and `└` layout, `Ran` and `Explored` blocks, merged reads, and 5-line output previews.
- [fx](https://github.com/vercel-labs/fx): listing a script's calls one per line.
- Claude Code ([interactive mode](https://code.claude.com/docs/en/interactive-mode)): tool detail collapsed until expanded.
