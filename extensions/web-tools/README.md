# Pi Web Tools

Run `/web-tools` to configure credentials, context budgets, cost limits, and capability groups. The configuration UI opens immediately; Keychain and credit-status checks refresh in the background instead of blocking the slash command. API keys use `FIRECRAWL_API_KEY` or macOS Keychain. `FIRECRAWL_API_URL` selects an API root; `FIRECRAWL_BASE_URL` selects its v2 base. If both are set, they must resolve to the same root so direct and SDK traffic cannot diverge.

> **Network security:** URL checks in this extension are only a client-side preflight. Firecrawl performs the target connection and resolves redirects itself. Only use a Firecrawl deployment whose DNS resolver or egress proxy blocks loopback, link-local, and private networks on every connection and redirect; client-side DNS validation cannot prevent rebinding at provider egress.

## Default model-facing tools

- `web_search` — bounded discovery when the URL is unknown
- `web_fetch` — synchronous extraction of exactly one URL
- `web_map` — bounded URL discovery within one site

All other capabilities are disabled by default. Enable batch, crawl, interact, extract, browser, agent, parse, monitor, search-feedback, or research capabilities from `/web-tools` only when needed. When **Defer specialized tools** is enabled, configured capabilities remain available but only `web_capabilities` is initially exposed; it activates the smallest required group additively for prompt-cache and tool-selection efficiency.

## Evidence-grounded research skill

The bundled `research` skill orchestrates the three core tools for current, comparative, obscure, multi-hop, and report-style research. Invoke it through Pi's native skill command:

```text
/skill:research <research question>
```

It provides adaptive quick/standard/deep/broad budgets, a private expiring evidence ledger, duplicate-query and stopping controls, source-quality and contradiction tracking, and verified claim-level citations. When the deferred `research_state` capability is loaded, the skill uses `web_research_state` to operate the ledger without temporary payload files or shell startup. Its full instructions load only when needed, so the default tool surface remains unchanged.

## Compact contracts

- Search defaults to 5 results and 500 characters per snippet, keeps a five-minute session cache for identical requests, and returns stable result IDs plus canonical URLs in structured details. The deferred `multi_search` capability runs 2–4 independent queries concurrently and fuses deduplicated results with Reciprocal Rank Fusion.
- Documents default to 4,000 content characters. `web_fetch.relevance_query` performs local query-aware passage selection without semantic-highlight charges.
- Tool output defaults to a 12,000-character ceiling and can never exceed 20,000 characters.
- Autonomous agent jobs default to a 100-credit hard ceiling configurable in `/web-tools`.
- Browser sessions reserve their maximum TTL cost at 2 credits per minute before opening; execution is allowed only for sessions tracked by the current Pi session, and close reconciles the reservation with `creditsBilled`.
- Batch and crawl starts reserve their worst-case proxy, requested-format, and bounded PDF parsing cost for every requested URL/page before the provider accepts the job.
- Batch and crawl status omit documents unless `include_content` is true.
- Large jobs return bounded pages and opaque `next_cursor` values.
- Full shaped output is written to a private temporary file when clipped.
- SDK responses are normalized before entering model context.
- Privacy-safe per-operation telemetry is appended to `~/.pi/agent/web-telemetry.jsonl`, rotated at 5 MB, and stores only input fingerprints rather than raw queries or URLs.
- Sensitive browser, interact, and monitor mutations require user confirmation.

## Install in Pi

This package is part of the parent `pi-extensions` workspace. Pi loads
`index.ts` and the bundled `research` skill through the root package manifest.
Local edits take effect after `/reload`.

## Development

```bash
pnpm install
pnpm check
```

Use `pnpm lsp` for the TypeScript language server. Oxlint and Oxformat language servers are available through `pnpm lsp:oxlint` and `pnpm lsp:oxformat`.

Evaluation fixtures and scoring instructions are under [`evals/`](./evals/).
