# Pi Extensions

A focused local extension suite for [Pi](https://github.com/badlogic/pi-mono): native interactive clarification, faster Codex requests, bounded web access, a native MCP server menu, plain-language restatements, visual explanations, plan stress-testing, repo-native domain docs, multi-session planning, stateful teaching, session handoffs, safe PR publishing, and human-invoked PR autopilot.

The workspace is one Pi package, so installation exposes every extension, the bundled skills, and the `origin` theme together.

## Extension suite

| Extension                                   | Use it when…                                                            | Main entry point                             | Side effects                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| [Question](extensions/question/README.md)   | The agent needs a material clarification without ending its current run | `question`                                   | Pauses the active tool call until the user answers or cancels |
| [Fast Mode](extensions/fast-mode/README.md) | You want eligible Codex requests to ask for priority service            | `/fast`                                      | Changes global Fast Mode state; may affect provider billing   |
| [Web Tools](extensions/web-tools/README.md) | You need live search, mapping, linked-page crawling, or extraction      | `search`, `map`, `fetch`, `crawl`, `extract` | Calls Firecrawl and spends provider credits                   |
| [MCP](extensions/mcp/README.md)             | You want Pi to use MCP servers already configured for other agents      | `/mcp`                                       | Connects enabled servers and registers their tools            |

The `question` tool is available in ordinary TUI and RPC chats. Its TUI batches related questions into one native layered dialog and returns answers to the same agent run without requiring a separate user turn.

Also included:

- [Dillon Mulroy's `/skill:bro`](skills/bro/SKILL.md), restates the last message in plain human language, with no jargon
- [Matt Pocock's `/skill:grill-me`](skills/grill-me/SKILL.md), stress-tests a plan through a [`grilling`](skills/grilling/SKILL.md) workflow adapted to use Pi's native `question` tool
- [Matt Pocock's `/skill:grill-with-docs`](skills/grill-with-docs/SKILL.md), the same interview in a working directory, writing glossary terms and ADRs through [`domain-modeling`](skills/domain-modeling/SKILL.md)
- [Matt Pocock's `/skill:wayfinder`](skills/wayfinder/SKILL.md), charts an effort too big for one session as a shared map of decision tickets. Run [`/skill:setup-matt-pocock-skills`](skills/setup-matt-pocock-skills/SKILL.md) once per repo first
- [Matt Pocock's `/skill:prototype`](skills/prototype/SKILL.md), throwaway code that answers a look, feel, or logic question
- [Matt Pocock's `/skill:research`](skills/research/SKILL.md), investigates a question against primary sources and writes a cited Markdown file
- [Matt Pocock's `/skill:diagnosing-bugs`](skills/diagnosing-bugs/SKILL.md), a diagnosis loop for hard bugs and performance regressions
- [Matt Pocock's `/skill:resolving-merge-conflicts`](skills/resolving-merge-conflicts/SKILL.md), resolves an in-progress merge or rebase hunk by hunk from each side's intent
- [Matt Pocock's `/skill:wizard`](skills/wizard/SKILL.md), generates an interactive bash wizard for steps only a human can perform
- [Matt Pocock's `/skill:handoff`](skills/handoff/SKILL.md), compacts the current conversation into a temporary handoff document for a fresh agent
- [Matt Pocock's `/skill:teach`](skills/teach/SKILL.md), builds a stateful teaching workspace with sourced lessons, reference materials, and learning records
- [HumanLayer's `/skill:show-me`](skills/show-me/SKILL.md), helps explain the current topic with concise diagrams, code-shape sketches, and focused HTML artifacts
- [`/skill:autopilot`](skills/autopilot/SKILL.md), drives an existing GitHub PR to merge readiness in the current agent session
- [`/skill:yeet`](skills/yeet/SKILL.md), verifies, commits, pushes, and creates or updates one ready-for-review pull request while preserving user work

`autopilot`, `bro`, `grill-me`, `grill-with-docs`, `handoff`, `setup-matt-pocock-skills`, `teach`, `wayfinder`, and `yeet` are manual-only. `diagnosing-bugs`, `domain-modeling`, `grilling`, `prototype`, `research`, `resolving-merge-conflicts`, `show-me`, and `wizard` can also be selected by the model when their descriptions match the task. The `bro`, `show-me`, `teach`, `diagnosing-bugs`, `domain-modeling`, `prototype`, and `resolving-merge-conflicts` files are unmodified upstream copies; `grill-me`, `grill-with-docs`, `handoff`, `setup-matt-pocock-skills`, `wayfinder`, and `wizard` are adapted to name Pi skill commands; `grilling` is adapted to use the native question dialog; `research` is adapted to use Pi web tools and not nest research agents. See the [third-party notices](THIRD_PARTY_NOTICES.md).

## Quick start

### Requirements

- Pi with package/extension support
- Node.js 22.19 or newer
- pnpm 11
- Provider credentials for the models you use
- A Firecrawl API key only if using Web Tools
- GitHub CLI (`gh`) for `/skill:autopilot`, `/skill:yeet`, GitHub-backed `/skill:wayfinder`, and `/skill:wizard` secret writes

### Install this checkout

```bash
git clone <repository-url> pi-extensions
cd pi-extensions
pnpm install
pi install "$(pwd)"
```

Pi packages execute code with the user's permissions. Review the checkout before installing it.

Start Pi. For local development, changes become active after:

```text
/reload
```

To remove the package later, use `pi remove` with the same package source shown by Pi's package configuration.

## Five-minute tour

### 1. Toggle priority Codex service

```text
/fast
```

Eligible `openai-codex` requests gain `service_tier: "priority"`; the built-in footer shows `ϟ` while the selected model is eligible.

### 2. Enable MCP servers

```text
/mcp
```

The menu lists servers from `~/.config/mcp/mcp.json`, including executor if you already configured it for other agents. Enter toggles a server on or off. Enabled servers register tools such as `mcp__executor__execute` in the current session.

### 3. Configure minimal web access

Store the Firecrawl key through Pi's masked, cross-platform login flow:

```text
/login firecrawl
```

Pi saves it in the user-only credential file at `~/.pi/agent/auth.json`; no shell export or restart is required. `FIRECRAWL_API_KEY` remains available for CI and other non-interactive use.

Web Tools exposes five always-active tools: `search`, `map`, `fetch`, `crawl`, and `extract`. Crawl and structured extraction can spend substantially more Firecrawl credits than ordinary search, map, or fetch calls.

### 4. Ask for a simpler explanation

```text
/skill:bro
```

The agent restates its previous response in plain, concise language.

### 5. Show a topic

```text
/skill:show-me the research workflow
```

The agent picks the smallest useful view, using pseudocode, trees, Mermaid, diffs, code, or a focused HTML artifact.

### 6. Stress-test a plan

```text
/skill:grill-me
```

The agent interviews you through the native layered question dialog, asking up to four current design-tree decisions per round until every branch is resolved and you confirm the shared understanding.

In a repository, `/skill:grill-with-docs` runs the same interview and writes resolved terms into `CONTEXT.md` and hard decisions into ADRs as they land.

If the effort will not fit in one session, `/skill:wayfinder` charts it as a shared map of decision tickets and walks them one session at a time. Run `/skill:setup-matt-pocock-skills` once in that repo first so the map has a tracker to live on.

### 7. Hand off work to a fresh session

```text
/skill:handoff focus next on the authentication tests
```

The agent writes a compact, redacted continuation document to the OS temporary directory. It references existing artifacts instead of duplicating them and suggests relevant skills for the next agent.

### 8. Start a stateful learning workspace

Run Pi from a directory dedicated to one learning goal, then invoke:

```text
/skill:teach learn Rust well enough to ship a CLI for my team
```

The agent clarifies your mission, curates trusted resources, and builds short HTML lessons, reference material, and learning records in that directory.

### 9. Publish finished work

```text
/skill:yeet
```

`/skill:yeet` inspects the repository, runs appropriate checks, creates one commit when needed, pushes without force, and creates or updates a non-draft PR using the repository template.

### 10. Keep an existing PR merge-ready

Start a fresh agent on the PR branch, then invoke:

```text
/skill:autopilot
```

You can also pass a PR number, URL, or branch. The current agent—not a subagent—repeatedly refreshes the PR, resolves safe conflicts, triages review threads, fixes in-scope CI failures, and waits for checks. It reports readiness but never merges, enables auto-merge, or marks a draft ready.

## Choosing the right primitive

| Need                                          | Prefer                             | Why                                                      |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| Material ambiguity during an active run       | `question`                         | Pauses in place and resumes with a compact answer map    |
| One known page needing readable evidence      | `fetch`                            | Smallest live-web reading operation                      |
| One known site, but not the exact page        | `map`, then `fetch`                | Discovers site URLs without crawling every page          |
| Several linked pages in one section           | `crawl`                            | Bounded, resumable document windows                      |
| Machine-readable fields from one exact page   | `extract`                          | JSON-mode extraction with prompt-injection checking      |
| Unknown source                                | `search`, then selective fetches   | Bounded discovery before reading primary sources         |
| The last answer was confusing or too wordy    | `/skill:bro`                       | A simpler, concise restatement without jargon            |
| A concept would be clearer as a visual        | `/skill:show-me`                   | Concise diagrams, code-shape sketches, or focused HTML   |
| A plan or design needs every assumption aired | `/skill:grill-me`                  | Native question dialogs over the design-tree frontier    |
| The same interview, plus glossary and ADRs    | `/skill:grill-with-docs`           | Writes `CONTEXT.md` and ADRs as terms and decisions land |
| An effort too big to decide in one session    | `/skill:wayfinder`                 | Shared map of decision tickets, one ticket per session   |
| First-time engineering-skill setup in a repo  | `/skill:setup-matt-pocock-skills`  | Issue tracker and domain-doc layout wayfinder reads      |
| Throwaway code to answer look, feel, or logic | `/skill:prototype`                 | Shareable HTML demo or switchable UI variants            |
| External facts from primary sources           | `/skill:research`                  | Cited Markdown file from official docs, specs, or code   |
| A hard bug or performance regression          | `/skill:diagnosing-bugs`           | Tight red loop, then hypothesise, instrument, and fix    |
| An in-progress merge or rebase conflict       | `/skill:resolving-merge-conflicts` | Resolve hunks by intent, then finish the operation       |
| A human-only setup, secret, or dashboard step | `/skill:wizard`                    | Interactive bash wizard the human runs themselves        |
| A fresh session should continue current work  | `/skill:handoff [focus]`           | Compact, redacted context saved outside the repository   |
| You want a multi-session personalized course  | `/skill:teach [topic]`             | Stateful lessons grounded in one learning mission        |
| Finished changes ready for GitHub             | `/skill:yeet`                      | Repo-native verification and PR-template workflow        |
| An existing PR should be kept merge-ready     | `/skill:autopilot [PR]`            | Human-started conflict, review, and CI reconciliation    |
| MCP servers already set up for other agents   | `/mcp`                             | Native enable/disable menu over shared MCP config        |

A useful sequence for larger changes is:

```text
web evidence → yeet → autopilot
```

Each stage has a different trust boundary: external evidence, publication, then ongoing PR maintenance.

## Command reference

| Command                            | Description                                                       |
| ---------------------------------- | ----------------------------------------------------------------- |
| `/login firecrawl`                 | Store a Firecrawl key in Pi's cross-platform credential file      |
| `/logout firecrawl`                | Remove the Firecrawl key stored by Pi                             |
| `/fast`                            | Toggle global Codex Fast Mode                                     |
| `/mcp`                             | Enable or disable configured MCP servers                          |
| `/skill:autopilot [PR]`            | Keep an existing GitHub PR merge-ready in the current agent       |
| `/skill:bro`                       | Restate the previous response simply, concisely, and coherently   |
| `/skill:diagnosing-bugs`           | Diagnose a hard bug or performance regression                     |
| `/skill:grill-me`                  | Stress-test a plan through native question-dialog rounds          |
| `/skill:grill-with-docs`           | Grill a plan and write glossary terms and ADRs as they resolve    |
| `/skill:handoff [focus]`           | Write a compact continuation document for a fresh agent           |
| `/skill:prototype [question]`      | Build throwaway code that answers a look, feel, or logic question |
| `/skill:research [question]`       | Research a question against primary sources into a cited file     |
| `/skill:resolving-merge-conflicts` | Resolve an in-progress merge or rebase by intent                  |
| `/skill:setup-matt-pocock-skills`  | Configure tracker and domain docs for wayfinder in a repo         |
| `/skill:show-me [topic]`           | Explain a topic with concise diagrams, code shapes, or HTML       |
| `/skill:teach [topic]`             | Build a stateful, sourced course in the current directory         |
| `/skill:wayfinder [idea or map]`   | Chart or walk a multi-session map of decision tickets             |
| `/skill:wizard [procedure]`        | Generate an interactive bash wizard for human-only steps          |
| `/skill:yeet [instructions]`       | Publish appropriate work as one ready PR                          |

See each extension README for complete syntax, safety constraints, and troubleshooting.

## Configuration and persisted data

Defaults below assume Pi's standard agent directory, `~/.pi/agent`.

| Feature       | Location                     | Contains                                                            |
| ------------- | ---------------------------- | ------------------------------------------------------------------- |
| Theme         | `themes/origin.json`         | Packaged TUI theme; select with `"theme": "origin"` in settings     |
| Fast Mode     | `~/.pi/agent/fast-mode.json` | Global on/off state                                                 |
| Firecrawl key | `~/.pi/agent/auth.json`      | API credential stored by `/login firecrawl` with `0600` permissions |
| MCP servers   | `~/.config/mcp/mcp.json`     | Shared MCP server definitions, including executor                   |
| MCP overlay   | `~/.pi/agent/mcp.json`       | Pi-only enable/disable flags; does not copy secrets                 |

## Security model

These are trusted local extensions, not sandboxes around Pi itself.

- Pi extensions run with the user's process permissions.
- Pi's `auth.json` credential store is user-readable plaintext protected by filesystem permissions, not an encrypted OS keychain.
- MCP servers run with the user's process permissions. `/mcp` persists enable/disable flags in `~/.pi/agent/mcp.json` and does not copy shared-config secrets into that overlay.
- Web content, repository content, GitHub data, and model output are treated as untrusted data.
- Web Tools applies client-side URL checks, but the Firecrawl deployment must enforce private-network blocking at provider egress and on redirects.
- `/skill:yeet` can create commits, push a branch, and open a public PR. It stops on suspicious files, likely secrets, destructive changes, or unrelated work.
- `/skill:autopilot` can check out a PR branch, merge its base, create commits, push, reply to reviews, and resolve threads. It never merges the PR, enables auto-merge, marks a draft ready, force-pushes, or rewrites history.
- `/skill:grill-with-docs` and `/skill:domain-modeling` write `CONTEXT.md` and ADRs into the current repository.
- `/skill:setup-matt-pocock-skills` writes `docs/agents/` files and an `## Agent skills` block in `AGENTS.md` or `CLAUDE.md`.
- `/skill:wayfinder` can create, assign, comment on, and close issues or local markdown tickets. It plans; it does not implement the destination.
- `/skill:prototype` writes throwaway code next to the thing it is prototyping and may commit it to a throwaway branch.
- `/skill:resolving-merge-conflicts` can finish a merge or rebase and create a commit. It never runs `--abort`.
- `/skill:wizard` can write `.env` values and GitHub Actions secrets. The generated script is run by the user, not by the agent.

Read the extension-specific safety section before enabling mutating or billed capabilities.

## Repository layout

```text
.
├── src/index.ts                    # Reserved workspace-wide extension entry point
├── extensions/
│   ├── question/                   # question
│   ├── fast-mode/                  # /fast
│   ├── web-tools/                  # search, map, fetch, crawl, and extract
│   └── mcp/                        # /mcp
├── skills/
│   ├── autopilot/                  # Human-invoked PR reconciliation loop
│   ├── bro/                        # Dillon Mulroy's /skill:bro
│   ├── diagnosing-bugs/            # Hard-bug diagnosis loop
│   ├── domain-modeling/            # Glossary and ADR writer used by grilling
│   ├── grill-me/                   # Matt Pocock's /skill:grill-me entry point
│   ├── grill-with-docs/            # Stateful grilling that writes domain docs
│   ├── grilling/                   # Interview workflow adapted for question
│   ├── handoff/                    # Matt Pocock's /skill:handoff
│   ├── prototype/                  # Throwaway logic and UI prototypes
│   ├── research/                   # Primary-source research into a cited file
│   ├── resolving-merge-conflicts/  # Intent-based merge and rebase resolution
│   ├── setup-matt-pocock-skills/   # Per-repo tracker and domain-doc setup
│   ├── show-me/                    # HumanLayer's /skill:show-me
│   ├── teach/                      # Matt Pocock's /skill:teach
│   ├── wayfinder/                  # Multi-session map of decision tickets
│   ├── wizard/                     # Interactive bash wizard for human-only steps
│   └── yeet/                       # Human-invoked PR publishing
├── THIRD_PARTY_NOTICES.md          # Skill provenance and licenses
├── themes/origin.json               # origin TUI theme
├── package.json                    # root Pi package manifest
└── pnpm-workspace.yaml             # extension workspace packages
```

## Development

Enter the pinned Nix development shell, then install dependencies once:

```bash
nix develop
pnpm install
```

If you do not use Nix, install the Node.js and pnpm versions listed in [Requirements](#requirements) and run `pnpm install` directly.

Run the complete workspace validation:

```bash
pnpm check
nix flake check # Reproducible sandboxed equivalent
```

Format the Nix source with `nix fmt`.

Common focused commands:

```bash
pnpm check:root
pnpm --filter pi-question check
pnpm --filter pi-fast-mode check
pnpm --filter pi-web-tools check
pnpm --filter pi-mcp check
pnpm format
pnpm lint
pnpm lint:fix
pnpm typecheck
pnpm lsp
```

### Git hooks

The repository uses [hk](https://hk.jdx.dev/) through `hk.pkl`.

```bash
hk install --global
hk check
hk fix
hk run pre-commit
```

- **pre-commit:** formats/fixes with Oxfmt and Oxlint, then type-checks.
- **pre-push:** runs the check-only equivalent.

### Adding an extension

1. Create a package under `extensions/<name>/`.
2. Add it to `pnpm-workspace.yaml`.
3. Expose its entry point in the root `package.json` `pi.extensions` array.
4. Put Pi framework packages in both `peerDependencies` and `devDependencies`.
5. Put non-Pi runtime libraries in `dependencies`.
6. Add focused tests, a complete README, and the package to the root `check` script.
7. Run `pnpm check`, then smoke-test with Pi and `/reload`.

## Documentation map

- [Question](extensions/question/README.md)
- [Fast Mode](extensions/fast-mode/README.md)
- [Web Tools](extensions/web-tools/README.md)
- [MCP](extensions/mcp/README.md)
- [Autopilot skill](skills/autopilot/SKILL.md)
- [Bro skill](skills/bro/SKILL.md)
- [Diagnosing Bugs skill](skills/diagnosing-bugs/SKILL.md)
- [Domain Modeling skill](skills/domain-modeling/SKILL.md)
- [Grill Me skill](skills/grill-me/SKILL.md)
- [Grill With Docs skill](skills/grill-with-docs/SKILL.md)
- [Grilling workflow](skills/grilling/SKILL.md)
- [Handoff skill](skills/handoff/SKILL.md)
- [Prototype skill](skills/prototype/SKILL.md)
- [Research skill](skills/research/SKILL.md)
- [Resolving Merge Conflicts skill](skills/resolving-merge-conflicts/SKILL.md)
- [Setup Matt Pocock Skills](skills/setup-matt-pocock-skills/SKILL.md)
- [Show Me skill](skills/show-me/SKILL.md)
- [Teach skill](skills/teach/SKILL.md)
- [Wayfinder skill](skills/wayfinder/SKILL.md)
- [Wizard skill](skills/wizard/SKILL.md)
- [Yeet skill](skills/yeet/SKILL.md)
- [Bundled skill third-party notices](THIRD_PARTY_NOTICES.md)
