# Pi Extensions

A focused local extension suite for [Pi](https://github.com/badlogic/pi-mono): native interactive clarification, faster Codex requests, deferred tool discovery, minimal web access, plain-language restatements, visual explanations, plan stress-testing, session handoffs, independent review/fix loops, and a safe PR-publishing prompt.

The workspace is one Pi package, so installation exposes every extension, the bundled skills, prompt templates, and the `origin` theme together.

## Extension suite

| Extension                                       | Use it when…                                                                                              | Main entry point              | Side effects                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------- |
| [Question](extensions/question/README.md)       | The agent needs a material clarification without ending its current run                                   | `question`                    | Pauses the active tool call until the user answers or cancels    |
| [Fast Mode](extensions/fast-mode/README.md)     | You want eligible Codex requests to ask for priority service                                              | `/fast`                       | Changes global Fast Mode state; may affect provider billing      |
| [Tool Search](extensions/tool-search/README.md) | The active tools cannot perform a task and a specialized capability should be loaded on demand            | `tool_search`, `/tool-search` | Additively activates registered Pi tools                         |
| [Web Tools](extensions/web-tools/README.md)     | You need live search, site mapping, or page extraction                                                    | `search`, `map`, `fetch`      | Calls Firecrawl and spends provider credits                      |
| [Review](extensions/review/README.md)           | You want either an interactive review handoff or an independent review/fix loop that verifies convergence | `/review`, `/loop-review`     | `/review` may check out a PR; `/loop-review` may edit its target |

The `question` tool is available in ordinary TUI and RPC chats. Its TUI batches related questions into one native layered dialog and returns answers to the same agent run without requiring a separate user turn.

Also included:

- [Dillon Mulroy's `/skill:bro`](skills/bro/SKILL.md), restates the last message in plain human language, with no jargon
- [Matt Pocock's `/skill:grill-me`](skills/grill-me/SKILL.md), stress-tests a plan through a [`grilling`](skills/grilling/SKILL.md) workflow adapted to use Pi's native `question` tool
- [Matt Pocock's `/skill:handoff`](skills/handoff/SKILL.md), compacts the current conversation into a temporary handoff document for a fresh agent
- [HumanLayer's `/skill:show-me`](skills/show-me/SKILL.md), helps explain the current topic with concise diagrams, code-shape sketches, and focused HTML artifacts
- [`/yeet`](prompt/yeet.md), a prompt template that verifies, commits, pushes, and creates or updates one ready-for-review pull request while preserving user work

`bro`, `grill-me`, and `handoff` are manual-only. `show-me` and `grilling` can also be selected by the model when their descriptions match the task. The `bro` and `show-me` files are unmodified upstream copies; `grill-me` and `handoff` are adapted to name Pi skill commands, and `grilling` is adapted to use the native question dialog. See the [third-party notices](THIRD_PARTY_NOTICES.md).

## Quick start

### Requirements

- Pi with package/extension support
- Node.js 22.19 or newer
- pnpm 11
- Provider credentials for the models you use
- A Firecrawl API key only if using Web Tools
- GitHub CLI (`gh`) only for Review Loop PR targets or `/yeet`

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

### 2. Configure minimal web access

Set the Firecrawl key before starting Pi:

```bash
export FIRECRAWL_API_KEY="fc-..."
```

Web Tools exposes three always-active tools: `search`, `map`, and `fetch`.

### 3. Ask for a simpler explanation

```text
/skill:bro
```

The agent restates its previous response in plain, concise language.

### 4. Show a topic

```text
/skill:show-me the review loop
```

The agent picks the smallest useful view, using pseudocode, trees, Mermaid, diffs, code, or a focused HTML artifact.

### 5. Stress-test a plan

```text
/skill:grill-me
```

The agent interviews you through the native layered question dialog, asking up to four current design-tree decisions per round until every branch is resolved and you confirm the shared understanding.

### 6. Hand off work to a fresh session

```text
/skill:handoff focus next on the authentication tests
```

The agent writes a compact, redacted continuation document to the OS temporary directory. It references existing artifacts instead of duplicating them and suggests relevant skills for the next agent.

### 7. Review changes

Start a one-pass review in an empty branch of the current Pi session, then return with a structured handoff:

```text
/review uncommitted
/end-review
```

For automatic repair and independent convergence checking, use the bounded loop. Configure 1–8 blind review agents plus separate reviewer, finding-verifier, and fixer models in `/settings-review`; reviewers run concurrently on each pass:

```text
/loop-review uncommitted --mode adversarial
/loop-review uncommitted --mode adversarial --extra "Prioritize auth boundaries and regression coverage"
```

The loop uses a fresh blind reviewer panel each pass, independently verifies candidate findings before repair, applies confirmed findings through a guarded fixer, and optionally runs deterministic checks.

### 8. Publish finished work

```text
/yeet
```

`/yeet` inspects the repository, runs appropriate checks, creates one commit when needed, pushes without force, and creates or updates a non-draft PR using the repository template.

## Choosing the right primitive

| Need                                          | Prefer                           | Why                                                           |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| Material ambiguity during an active run       | `question`                       | Pauses in place and resumes with a compact answer map         |
| One known page                                | `fetch`                          | Smallest live-web operation                                   |
| One known site, but not the exact page        | `map`, then `fetch`              | Discovers site URLs without crawling every page               |
| Missing specialized capability                | `tool_search`                    | Loads the smallest matching namespaced tool bundle additively |
| Unknown source                                | `search`, then selective fetches | Bounded discovery before extraction                           |
| One interactive review with a handoff         | `/review`, then `/end-review`    | Isolates review on a session branch and can queue fixes       |
| Independent review, repair, and convergence   | `/loop-review`                   | Purpose-built convergence and Git safety                      |
| The last answer was confusing or too wordy    | `/skill:bro`                     | A simpler, concise restatement without jargon                 |
| A concept would be clearer as a visual        | `/skill:show-me`                 | Concise diagrams, code-shape sketches, or focused HTML        |
| A plan or design needs every assumption aired | `/skill:grill-me`                | Native question dialogs over the design-tree frontier         |
| A fresh session should continue current work  | `/skill:handoff [focus]`         | Compact, redacted context saved outside the repository        |
| Finished changes ready for GitHub             | `/yeet`                          | Repo-native verification and PR-template workflow             |

A useful sequence for larger changes is:

```text
web evidence → review loop → yeet
```

Each stage has a different trust boundary: external evidence, independent verification, then publication.

## Command reference

| Command                  | Description                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| `/fast`                  | Toggle global Codex Fast Mode                                     |
| `/tool-search`           | Show available namespaced deferred-tool capabilities              |
| `/skill:bro`             | Restate the previous response simply, concisely, and coherently   |
| `/skill:grill-me`        | Stress-test a plan through native question-dialog rounds          |
| `/skill:handoff [focus]` | Write a compact continuation document for a fresh agent           |
| `/skill:show-me [topic]` | Explain a topic with concise diagrams, code shapes, or HTML       |
| `/review [target]`       | Start an interactive review in an empty branch or current session |
| `/settings-review`       | Configure Review Loop mode, models, and convergence               |
| `/end-review`            | Return from an isolated review, optionally summarize or fix       |
| `/loop-review [target]`  | Run standard or parallel specialized review/fix loops             |
| `/yeet [instructions]`   | Publish appropriate work as one ready PR                          |

See each extension README for complete syntax, safety constraints, and troubleshooting.

## Configuration and persisted data

Defaults below assume Pi's standard agent directory, `~/.pi/agent`.

| Feature            | Location                       | Contains                                                            |
| ------------------ | ------------------------------ | ------------------------------------------------------------------- |
| Theme              | `themes/origin.json`           | Packaged TUI theme; select with `"theme": "origin"` in settings     |
| Fast Mode          | `~/.pi/agent/fast-mode.json`   | Global on/off state                                                 |
| Firecrawl key      | `FIRECRAWL_API_KEY`            | API credential provided through the process environment             |
| Interactive review | Current Pi session             | Review-branch origin and custom instructions                        |
| Review loop        | `~/.pi/agent/review-loop.json` | Role model references, reasoning, convergence, verification command |

Provider credentials are not written into Review Loop settings.

## Security model

These are trusted local extensions, not sandboxes around Pi itself.

- Pi extensions run with the user's process permissions.
- Web content, repository content, GitHub data, and model output are treated as untrusted data.
- Web Tools applies client-side URL checks, but the Firecrawl deployment must enforce private-network blocking at provider egress and on redirects.
- `/review pr` checks out a GitHub PR locally; `/loop-review` gives trusted reviewer models the user's active tools and general Bash while keeping fixer mutations guarded.
- `/yeet` can create commits, push a branch, and open a public PR. It stops on suspicious files, likely secrets, destructive changes, or unrelated work.

Read the extension-specific safety section before enabling mutating or billed capabilities.

## Repository layout

```text
.
├── src/index.ts                    # Reserved workspace-wide extension entry point
├── extensions/
│   ├── question/                   # question
│   ├── fast-mode/                  # /fast
│   ├── tool-search/                # tool_search and capability registry
│   ├── web-tools/                  # search, map, and fetch
│   └── review/                     # /review, /end-review, /loop-review
├── skills/
│   ├── bro/                        # Dillon Mulroy's /skill:bro
│   ├── grill-me/                   # Matt Pocock's /skill:grill-me entry point
│   ├── grilling/                   # Interview workflow adapted for question
│   ├── handoff/                    # Matt Pocock's /skill:handoff
│   └── show-me/                    # HumanLayer's /skill:show-me
├── THIRD_PARTY_NOTICES.md          # Skill provenance and licenses
├── prompt/yeet.md                  # /yeet prompt template
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
pnpm --filter pi-tool-search check
pnpm --filter pi-web-tools check
pnpm --filter pi-review check
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
- [Tool Search](extensions/tool-search/README.md)
- [Web Tools](extensions/web-tools/README.md)
- [Bro skill](skills/bro/SKILL.md)
- [Grill Me skill](skills/grill-me/SKILL.md)
- [Grilling workflow](skills/grilling/SKILL.md)
- [Handoff skill](skills/handoff/SKILL.md)
- [Show Me skill](skills/show-me/SKILL.md)
- [Bundled skill third-party notices](THIRD_PARTY_NOTICES.md)
- [Review](extensions/review/README.md)
- [Review Loop design plan](extensions/review/PLAN.md)
- [`/yeet` prompt](prompt/yeet.md)
