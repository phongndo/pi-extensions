# Pi Extensions

A focused local extension suite for [Pi](https://github.com/badlogic/pi-mono): native interactive clarification, faster Codex requests, minimal web access, plain-language restatements, visual explanations, plan stress-testing, session handoffs, safe PR publishing, and human-invoked PR autopilot.

The workspace is one Pi package, so installation exposes every extension, the bundled skills, prompt templates, and the `origin` theme together.

## Extension suite

| Extension                                   | Use it when…                                                            | Main entry point         | Side effects                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| [Question](extensions/question/README.md)   | The agent needs a material clarification without ending its current run | `question`               | Pauses the active tool call until the user answers or cancels |
| [Fast Mode](extensions/fast-mode/README.md) | You want eligible Codex requests to ask for priority service            | `/fast`                  | Changes global Fast Mode state; may affect provider billing   |
| [Web Tools](extensions/web-tools/README.md) | You need live search, site mapping, or page extraction                  | `search`, `map`, `fetch` | Calls Firecrawl and spends provider credits                   |

The `question` tool is available in ordinary TUI and RPC chats. Its TUI batches related questions into one native layered dialog and returns answers to the same agent run without requiring a separate user turn.

Also included:

- [Dillon Mulroy's `/skill:bro`](skills/bro/SKILL.md), restates the last message in plain human language, with no jargon
- [Matt Pocock's `/skill:grill-me`](skills/grill-me/SKILL.md), stress-tests a plan through a [`grilling`](skills/grilling/SKILL.md) workflow adapted to use Pi's native `question` tool
- [Matt Pocock's `/skill:handoff`](skills/handoff/SKILL.md), compacts the current conversation into a temporary handoff document for a fresh agent
- [HumanLayer's `/skill:show-me`](skills/show-me/SKILL.md), helps explain the current topic with concise diagrams, code-shape sketches, and focused HTML artifacts
- [`/skill:autopilot`](skills/autopilot/SKILL.md), drives an existing GitHub PR to merge readiness in the current agent session
- [`/yeet`](prompt/yeet.md), a prompt template that verifies, commits, pushes, and creates or updates one ready-for-review pull request while preserving user work

`autopilot`, `bro`, `grill-me`, and `handoff` are manual-only. `show-me` and `grilling` can also be selected by the model when their descriptions match the task. The `bro` and `show-me` files are unmodified upstream copies; `grill-me` and `handoff` are adapted to name Pi skill commands, and `grilling` is adapted to use the native question dialog. See the [third-party notices](THIRD_PARTY_NOTICES.md).

## Quick start

### Requirements

- Pi with package/extension support
- Node.js 22.19 or newer
- pnpm 11
- Provider credentials for the models you use
- A Firecrawl API key only if using Web Tools
- GitHub CLI (`gh`) only for `/skill:autopilot` and `/yeet`

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

Store the Firecrawl key through Pi's masked, cross-platform login flow:

```text
/login firecrawl
```

Pi saves it in the user-only credential file at `~/.pi/agent/auth.json`; no shell export or restart is required. `FIRECRAWL_API_KEY` remains available for CI and other non-interactive use.

Web Tools exposes three always-active tools: `search`, `map`, and `fetch`.

### 3. Ask for a simpler explanation

```text
/skill:bro
```

The agent restates its previous response in plain, concise language.

### 4. Show a topic

```text
/skill:show-me the research workflow
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

### 7. Publish finished work

```text
/yeet
```

`/yeet` inspects the repository, runs appropriate checks, creates one commit when needed, pushes without force, and creates or updates a non-draft PR using the repository template.

### 8. Keep an existing PR merge-ready

Start a fresh agent on the PR branch, then invoke:

```text
/skill:autopilot
```

You can also pass a PR number, URL, or branch. The current agent—not a subagent—repeatedly refreshes the PR, resolves safe conflicts, triages review threads, fixes in-scope CI failures, and waits for checks. It reports readiness but never merges, enables auto-merge, or marks a draft ready.

## Choosing the right primitive

| Need                                          | Prefer                           | Why                                                    |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------ |
| Material ambiguity during an active run       | `question`                       | Pauses in place and resumes with a compact answer map  |
| One known page                                | `fetch`                          | Smallest live-web operation                            |
| One known site, but not the exact page        | `map`, then `fetch`              | Discovers site URLs without crawling every page        |
| Unknown source                                | `search`, then selective fetches | Bounded discovery before extraction                    |
| The last answer was confusing or too wordy    | `/skill:bro`                     | A simpler, concise restatement without jargon          |
| A concept would be clearer as a visual        | `/skill:show-me`                 | Concise diagrams, code-shape sketches, or focused HTML |
| A plan or design needs every assumption aired | `/skill:grill-me`                | Native question dialogs over the design-tree frontier  |
| A fresh session should continue current work  | `/skill:handoff [focus]`         | Compact, redacted context saved outside the repository |
| Finished changes ready for GitHub             | `/yeet`                          | Repo-native verification and PR-template workflow      |
| An existing PR should be kept merge-ready     | `/skill:autopilot [PR]`          | Human-started conflict, review, and CI reconciliation  |

A useful sequence for larger changes is:

```text
web evidence → yeet → autopilot
```

Each stage has a different trust boundary: external evidence, publication, then ongoing PR maintenance.

## Command reference

| Command                  | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `/login firecrawl`       | Store a Firecrawl key in Pi's cross-platform credential file    |
| `/logout firecrawl`      | Remove the Firecrawl key stored by Pi                           |
| `/fast`                  | Toggle global Codex Fast Mode                                   |
| `/skill:autopilot [PR]`  | Keep an existing GitHub PR merge-ready in the current agent     |
| `/skill:bro`             | Restate the previous response simply, concisely, and coherently |
| `/skill:grill-me`        | Stress-test a plan through native question-dialog rounds        |
| `/skill:handoff [focus]` | Write a compact continuation document for a fresh agent         |
| `/skill:show-me [topic]` | Explain a topic with concise diagrams, code shapes, or HTML     |
| `/yeet [instructions]`   | Publish appropriate work as one ready PR                        |

See each extension README for complete syntax, safety constraints, and troubleshooting.

## Configuration and persisted data

Defaults below assume Pi's standard agent directory, `~/.pi/agent`.

| Feature       | Location                     | Contains                                                            |
| ------------- | ---------------------------- | ------------------------------------------------------------------- |
| Theme         | `themes/origin.json`         | Packaged TUI theme; select with `"theme": "origin"` in settings     |
| Fast Mode     | `~/.pi/agent/fast-mode.json` | Global on/off state                                                 |
| Firecrawl key | `~/.pi/agent/auth.json`      | API credential stored by `/login firecrawl` with `0600` permissions |

## Security model

These are trusted local extensions, not sandboxes around Pi itself.

- Pi extensions run with the user's process permissions.
- Pi's `auth.json` credential store is user-readable plaintext protected by filesystem permissions, not an encrypted OS keychain.
- Web content, repository content, GitHub data, and model output are treated as untrusted data.
- Web Tools applies client-side URL checks, but the Firecrawl deployment must enforce private-network blocking at provider egress and on redirects.
- `/yeet` can create commits, push a branch, and open a public PR. It stops on suspicious files, likely secrets, destructive changes, or unrelated work.
- `/skill:autopilot` can check out a PR branch, merge its base, create commits, push, reply to reviews, and resolve threads. It never merges the PR, enables auto-merge, marks a draft ready, force-pushes, or rewrites history.

Read the extension-specific safety section before enabling mutating or billed capabilities.

## Repository layout

```text
.
├── src/index.ts                    # Reserved workspace-wide extension entry point
├── extensions/
│   ├── question/                   # question
│   ├── fast-mode/                  # /fast
│   └── web-tools/                  # search, map, and fetch
├── skills/
│   ├── autopilot/                  # Human-invoked PR reconciliation loop
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
pnpm --filter pi-web-tools check
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
- [Autopilot skill](skills/autopilot/SKILL.md)
- [Bro skill](skills/bro/SKILL.md)
- [Grill Me skill](skills/grill-me/SKILL.md)
- [Grilling workflow](skills/grilling/SKILL.md)
- [Handoff skill](skills/handoff/SKILL.md)
- [Show Me skill](skills/show-me/SKILL.md)
- [Bundled skill third-party notices](THIRD_PARTY_NOTICES.md)
- [`/yeet` prompt](prompt/yeet.md)
