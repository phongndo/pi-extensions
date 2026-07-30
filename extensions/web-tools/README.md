# Pi Web Tools

> Firecrawl-powered search, extraction, site discovery, browser work, academic/GitHub research, and evidence-grounded reports—bounded for model context, provider credits, privacy, and operator control.

Web Tools gives Pi a deliberately small default surface (`web_search`, `web_fetch`, and `web_map`) plus specialized capabilities loaded only when a task justifies them. `/web-tools` controls credentials, context limits, session credit guards, expensive features, and which capability groups may be activated.

## At a glance

|                          |                                                          |
| ------------------------ | -------------------------------------------------------- |
| Configuration            | `/web-tools`                                             |
| Status                   | `/web-tools status`                                      |
| Research workflow        | `/skill:research <question>`                             |
| Provider                 | Firecrawl                                                |
| Default tools            | `web_search`, `web_fetch`, `web_map`, `web_capabilities` |
| Default specialized mode | Deferred and additive                                    |
| Config                   | `~/.pi/agent/web.json`                                   |
| Telemetry                | `~/.pi/agent/web-telemetry.jsonl`                        |
| API key                  | `FIRECRAWL_API_KEY` or macOS Keychain                    |

## Quick start

### 1. Configure Firecrawl

Open the TUI settings page:

```text
/web-tools
```

Select **API key**, paste a Firecrawl key, and press Enter. The key is validated before being stored in macOS Keychain.

Non-interactive/key-management commands:

```text
/web-tools status
/web-tools key
/web-tools remove-key
/web-tools reset
```

`FIRECRAWL_API_KEY` takes precedence over a Keychain key.

### 2. Ask for live information

A normal prompt is enough; the model receives routing guidance with the tools. For example:

```text
Find the current migration guide from the official vendor docs, fetch the relevant page, and summarize only the breaking changes with links.
```

The expected route is:

```text
unknown source → web_search → select sources → parallel web_fetch
```

### 3. Run rigorous research

```text
/skill:research Compare the current enterprise retention policies of Vendor A and Vendor B using primary sources, preserve contradictions, and cite every substantive claim.
```

The bundled skill adds an adaptive evidence ledger, source-quality checks, contradiction tracking, stopping rules, and claim-level citation verification.

## Routing: choose the smallest sufficient tool

| Situation                                            | Tool/path                                          |
| ---------------------------------------------------- | -------------------------------------------------- |
| The exact URL is known                               | `web_fetch`                                        |
| The source is unknown                                | `web_search`, then fetch 2–3 selected sources      |
| The site is known but the page is not                | `web_map`, then selective `web_fetch`              |
| Two to four independent queries are known upfront    | Load `multi_search` and use `web_search_many`      |
| Five or more known URLs need extraction              | Enable/load `batch`, then use `web_batch_fetch`    |
| Broad linked-page coverage of one site is required   | Enable/load `crawl` and use `web_crawl`            |
| A page needs clicks or dynamic navigation            | Enable/load `interact` or `browser`                |
| One page must become structured JSON                 | Enable/load `extract`                              |
| A difficult local PDF/document needs OCR             | Enable/load `parse`                                |
| The question needs scholarly literature              | Enable/load `academic`                             |
| The question needs GitHub implementation history     | Enable/load `academic`, then `web_github_research` |
| Deterministic tools cannot locate a complex answer   | Enable/load bounded `agent` as a last resort       |
| A multi-source answer needs auditable evidence state | `/skill:research` and `research_state`             |

The extension intentionally does not expose a generic code executor over web tools. Predictable concurrency, deduplication, pagination, and shaping are automated; adaptive query reformulation and citation judgment remain visible model decisions.

## Default tools

### `web_search`

Discovers live web/news/image results and optional GitHub, research, or PDF categories. It preserves Firecrawl's provider order and keeps one bounded query-relevant excerpt per result, preferring highlights over snippets and descriptions.

Good defaults:

- Start with 5 results.
- Use a time range only when freshness matters.
- Use domain filters to target first-party evidence.
- Fetch only the best 2–3 sources rather than treating snippets as evidence.

Identical requests use a five-minute session cache.

### `web_fetch`

Synchronously extracts exactly one known public HTTP(S) URL. It supports bounded formats such as Markdown, summary, HTML, links, images, screenshot, product/menu/branding, audio/video metadata, question answering, and highlights.

For a small selected set, issue 2–4 independent calls together so Pi runs them concurrently. `relevance_query` performs local passage selection without paying for semantic highlights.

### `web_map`

Discovers and ranks URLs within one known site without scraping every page. Use it to locate a documentation page, policy, changelog, or section before fetching selected URLs.

### `web_capabilities`

Loads configured specialized capability groups. Activation is additive for the current session, preserving prompt-cache efficiency and keeping irrelevant tool schemas out of model context.

```json
{
  "capabilities": ["multi_search", "batch"]
}
```

A capability must first be enabled in `/web-tools` unless it is inherently tied to an enabled core function.

## Specialized capabilities

| Capability        | Exposed tools                                                                    | Purpose                                                                         |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `multi_search`    | `web_search_many`                                                                | Run 2–4 queries concurrently with fair facet coverage or Reciprocal Rank Fusion |
| `search_feedback` | `web_search_feedback`                                                            | Rate a used/rejected search; first feedback may recover one search credit       |
| `batch`           | `web_batch_fetch`                                                                | Start/status/page/cancel larger known-URL extraction jobs                       |
| `crawl`           | `web_crawl`                                                                      | Bounded linked-page crawl with status and cursor pagination                     |
| `interact`        | `web_interact`                                                                   | Act in browser state attached to a scrape or URL                                |
| `extract`         | `web_extract`                                                                    | Extract one known page to a natural-language goal and optional JSON Schema      |
| `browser`         | `web_browser`                                                                    | Open/execute/list/close standalone billed browser sessions                      |
| `agent`           | `web_agent`                                                                      | Bounded autonomous Firecrawl research job for difficult discovery               |
| `parse`           | `web_parse`                                                                      | Upload and parse/OCR one local document, up to 50 MB                            |
| `monitor`         | `web_monitor`                                                                    | Read or mutate persistent scheduled monitors                                    |
| `academic`        | `web_paper_search`, `web_paper_read`, `web_paper_related`, `web_github_research` | Scholarly and repository-history research                                       |
| `research_state`  | `web_research_state`                                                             | Private evidence-ledger operations for the research skill                       |

When **Defer specialized tools** is off, enabled specialized tools are activated immediately. Deferred mode is recommended unless every turn needs the larger surface.

## Evidence-grounded research skill

Invoke the bundled Pi skill:

```text
/skill:research <question>
```

Use it for current comparisons, obscure facts, due diligence, multi-hop questions, broad source lists, or report-style outputs. Do not use it for a trivial fact or one known URL.

The skill supports four budget modes:

| Mode       | Best for                                              |
| ---------- | ----------------------------------------------------- |
| `quick`    | One narrow claim needing confirmation                 |
| `standard` | Comparisons and several related claims                |
| `deep`     | Obscure, adversarial, or contradiction-heavy research |
| `broad`    | Many independent entities or facets                   |

Its workflow:

1. Defines explicit answer criteria and source requirements.
2. Searches adaptively instead of issuing synonym-only queries.
3. Fetches selected primary sources.
4. Records claim-bearing excerpts in a private expiring ledger.
5. Tracks gaps, duplicate queries, contradictions, and source independence.
6. Verifies each evidence card against its fetched excerpt.
7. Produces a compact evidence pack with claim-level source URLs.

With `research_state` loaded, ledger operations stay inside a native deferred tool instead of temporary payload files and shell startup. See [`skills/research/SKILL.md`](skills/research/SKILL.md) for the complete method.

## Configuration

Run `/web-tools` in TUI mode to edit settings. The page opens immediately; Keychain and credit-status checks refresh in the background.

### Default context and cost guards

| Setting           |      Default | Meaning                                                    |
| ----------------- | -----------: | ---------------------------------------------------------- |
| Search results    |            5 | Results when a tool call omits `limit`                     |
| Maximum results   |           10 | Hard search-result cap                                     |
| Search excerpt    |    500 chars | Preferred excerpt retained per result                      |
| Document field    |  4,000 chars | Default content retained per fetched field                 |
| Tool output       | 12,000 chars | Hard shaped-result context budget; max configurable 20,000 |
| Job page size     |            5 | Documents per requested batch/crawl content page           |
| Request timeout   |   90 seconds | Firecrawl request timeout                                  |
| Default proxy     |       `auto` | Provider proxy strategy                                    |
| Batch URLs        |           10 | Maximum URLs accepted by one batch start                   |
| Crawl pages       |          100 | Maximum pages accepted by one crawl                        |
| Agent credits     |          100 | Maximum one autonomous job may request                     |
| Session credits   |          200 | Budget-aware operation guard per Pi session                |
| Specialized tools |     Deferred | Load only through `web_capabilities`                       |

The TUI also controls maximum scrape formats, expensive JSON/enhanced-proxy features, and every capability group.

### Tool defaults

Enabled initially:

- Search
- Fetch
- Map
- Deferred capability loader

Disabled initially:

- Search feedback
- Batch
- Crawl
- Interact
- Extract
- Browser
- Agent
- Parse
- Monitor
- Academic/GitHub research tools

`multi_search` becomes available for deferred loading whenever Search is enabled. `research_state` follows the Research tools toggle.

### Configuration file

Settings are normalized and stored at:

```text
~/.pi/agent/web.json
```

Use the TUI instead of hand-editing whenever possible. Reset to safe defaults with:

```text
/web-tools reset
```

## Authentication and custom endpoints

Credential precedence:

1. `FIRECRAWL_API_KEY`
2. macOS Keychain service `pi-firecrawl-web`
3. no credential

Environment setup:

```bash
export FIRECRAWL_API_KEY='fc-...'
```

Custom Firecrawl deployments:

```bash
export FIRECRAWL_API_URL='https://firecrawl.example.com'
export FIRECRAWL_BASE_URL='https://firecrawl.example.com/v2'
```

- `FIRECRAWL_API_URL` selects the API root used by the SDK.
- `FIRECRAWL_BASE_URL` selects the v2 base used by direct requests.
- If both are set, they must resolve to the same root. Divergent endpoints are rejected so authentication, billing, and security policy cannot silently split.

`/web-tools status` reports the active key source, credits when available, initial tools, deferred capabilities, context budgets, credit guards, telemetry, and config path.

## Credit controls

Web Tools reserves worst-case budget before starting operations whose final provider charge is not yet known.

- Search is billed by Firecrawl in provider-defined blocks.
- Batch and crawl reserve proxy, requested-format, and bounded PDF-parsing cost for every requested URL/page.
- Browser sessions reserve their maximum TTL at 2 credits per minute before opening, then reconcile against `creditsBilled` on close.
- Autonomous agent jobs cannot exceed the configured per-job ceiling.
- Session-aware operations refuse starts that would cross the configured session budget.
- Failed preflight or provider rejection releases reservations.

Provider billing remains authoritative. Use `/web-tools status` to compare reported and budgeted credits.

## Context shaping and provenance

All provider responses are normalized before entering model context.

- Search returns one bounded preferred excerpt per result.
- Documents default to 4,000 characters per content field.
- `relevance_query` selects a few locally relevant passages from fetched Markdown.
- Batch/crawl status omits documents unless `include_content` is true.
- Large jobs use opaque cursors and bounded pages.
- If shaped output exceeds the context ceiling, the clipped result identifies a private temporary file containing the full shaped output.
- Search/fetch outputs retain source URLs and provider provenance needed for citations.

The goal is not to maximize scraped text; it is to put the smallest useful evidence into the model context.

## Security and privacy

### Network boundary

URL validation is a **client-side preflight**, not an SSRF sandbox. Firecrawl performs the target connection and resolves redirects. Use only a Firecrawl deployment whose DNS resolver or egress proxy blocks loopback, link-local, private, and metadata networks on every connection and redirect. Client-side DNS checks cannot prevent rebinding at provider egress.

Pagination cursors are restricted to the configured Firecrawl origin and API path.

### Confirmed actions

Sensitive or persistent actions require user confirmation, including relevant browser/interact operations, local-document upload, and monitor mutations. Read-only status/list operations remain non-mutating.

`web_parse` transfers a local file to Firecrawl. Inspect the path and document sensitivity before approving.

### Telemetry

Privacy-safe operation telemetry is appended to:

```text
~/.pi/agent/web-telemetry.jsonl
```

It rotates at 5 MB and records operation timing, result size, credits, and error categories. Raw queries and URLs are replaced with input fingerprints.

## Common workflows

### Official documentation lookup

```text
1. web_search: query with include_domains for the vendor
2. web_fetch: fetch the exact official page
3. Answer from fetched text and cite the page URL
```

### Compare two vendors

```text
1. Load multi_search
2. web_search_many in facets mode, one query per vendor
3. Select primary sources
4. Fetch 2–4 pages in parallel
5. Preserve disagreements and cite claim by claim
```

### Find one page in a large documentation site

```text
1. web_map on the docs root with a focused search term
2. Select one or two candidate URLs
3. web_fetch with relevance_query
```

### Read a difficult PDF

Try `web_fetch` with bounded PDF parsing first. If the document is local or needs stronger OCR, enable/load `parse`, approve the upload, and use `web_parse`.

### Investigate a regression in an open-source project

Enable/load `academic`, then use `web_github_research` for issue/PR history and README evidence. Use ordinary `web_search` for release notes or external announcements.

## Troubleshooting

### “Firecrawl API key is required”

Run `/web-tools key` or set `FIRECRAWL_API_KEY`, then use `/web-tools status` to confirm the active source.

### A specialized tool is missing

Enable its group in `/web-tools`, then ask the model to call `web_capabilities` with the capability name. Activation is additive; disabling a capability in config affects future application/reload behavior.

### `/web-tools` says TUI mode is required

Use `/web-tools status`, `/web-tools key`, `/web-tools remove-key`, or `/web-tools reset` in non-TUI contexts. The full settings page requires TUI components.

### Output is too short

Increase the document/tool context limits carefully, or use a focused `relevance_query`. Avoid broad raw extraction when a few passages answer the question.

### A request is rejected as private

Only public HTTP(S) targets are accepted. Do not use Web Tools for localhost, private infrastructure, cloud metadata endpoints, or internal dashboards.

### Session budget is exhausted

Inspect `/web-tools status`, close unneeded browser sessions, reduce requested pages/formats, or start a new session only after confirming further spend is intended.

### Custom endpoints disagree

Ensure `FIRECRAWL_API_URL` is the API root and `FIRECRAWL_BASE_URL` is the matching `/v2` base on the same origin/root.

## Development and evaluation

```bash
pnpm --filter pi-web-tools check
pnpm --filter pi-web-tools format
pnpm --filter pi-web-tools lsp
pnpm --filter pi-web-tools lsp:oxlint
pnpm --filter pi-web-tools lsp:oxformat
```

After editing, run `/reload` in Pi.

Evaluation fixtures and scoring instructions live in [`evals/`](evals/). Research-ledger tests and evaluations live under [`skills/research/`](skills/research/). The test suite covers configuration normalization, URL/cursor safety, credit reservation, output shaping, deferred activation, browser ownership, confirmation boundaries, telemetry, native research state, and key-management UI behavior.
