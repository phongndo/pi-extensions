# Pi Extensions

A focused local extension suite for [Pi](https://github.com/badlogic/pi-mono): faster Codex requests, deferred tool discovery, bounded web research, independent review/fix loops, observable multi-agent procedures, and a safe PR-publishing prompt.

The workspace is one Pi package, so installation exposes every extension, the bundled research skill, and prompt templates together.

## Extension suite

| Extension                                       | Use it when…                                                                                              | Main entry point                | Side effects                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| [Fast Mode](extensions/fast-mode/README.md)     | You want eligible Codex requests to ask for priority service                                              | `/fast`                         | Changes global Fast Mode state; may affect provider billing                |
| [Tool Search](extensions/tool-search/README.md) | The active tools cannot perform a task and a specialized capability should be loaded on demand            | `tool_search`, `/tool-search`   | Additively activates registered Pi tools                                   |
| [Web Tools](extensions/web-tools/README.md)     | You need live search, page extraction, site mapping, browser work, or evidence-grounded research          | `/web-tools`, `/skill:research` | Calls Firecrawl; selected capabilities spend credits or mutate remote jobs |
| [Review](extensions/review/README.md)           | You want either an interactive review handoff or an independent review/fix loop that verifies convergence | `/review`, `/loop-review`       | `/review` may check out a PR; `/loop-review` may edit its target           |
| [Procedures](extensions/procedures/README.md)   | A task benefits from visible, code-driven multi-agent orchestration                                       | `/proc`, `/monitor`             | Depends on reviewed procedure source and declared child tools              |

Also included: [`/yeet`](prompt/yeet.md), a prompt template that verifies, commits, pushes, and creates or updates one ready-for-review pull request while preserving user work.

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

### 2. Configure bounded web access

```text
/web-tools
```

Add a Firecrawl key, inspect credits, choose context/cost limits, and decide which specialized capabilities can be activated. Deferred web capabilities register with the suite-level `tool_search` catalog under `web.*`. For a sourced research task:

```text
/skill:research Compare the current migration guidance from the two primary vendors.
```

### 3. Review changes

Start a one-pass review in an empty branch of the current Pi session, then return with a structured handoff:

```text
/review uncommitted
/end-review
```

For automatic repair and independent convergence checking, use the bounded loop. Configure 1–8 blind review agents in `/settings-review`; they run concurrently on each pass:

```text
/loop-review uncommitted --mode adversarial
/loop-review uncommitted --mode adversarial --extra "Prioritize auth boundaries and regression coverage"
```

The loop uses a fresh reviewer each pass, a guarded fixer, and optional deterministic verification.

### 4. Generate an observable workflow

```text
/proc Inspect this service, propose the smallest safe implementation, ask before editing, implement it, and verify the focused tests.
```

Review the generated JavaScript body and its declared child-agent tools. It then runs autonomously in the background; inspect it only when needed:

```text
/monitor
```

Generated procedures are ephemeral unless promoted explicitly with `/proc save`.

### 5. Publish finished work

```text
/yeet
```

`/yeet` inspects the repository, runs appropriate checks, creates one commit when needed, pushes without force, and creates or updates a non-draft PR using the repository template.

## Choosing the right primitive

| Need                                                                | Prefer                               | Why                                                                |
| ------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| One known page                                                      | `web_fetch`                          | Smallest live-web operation                                        |
| Missing specialized capability                                      | `tool_search`                        | Loads the smallest matching namespaced tool bundle additively      |
| Unknown source                                                      | `web_search`, then selective fetches | Bounded discovery before extraction                                |
| Rigorous multi-source report                                        | `/skill:research`                    | Evidence ledger, contradiction tracking, verified citations        |
| One interactive review with a handoff                               | `/review`, then `/end-review`        | Isolates review on a session branch and can queue fixes            |
| Independent review, repair, and convergence                         | `/loop-review`                       | Purpose-built convergence and Git safety                           |
| Custom fan-out/fan-in, optional checkpoints, or role specialization | `/proc`                              | Ordinary JavaScript owns control flow; `/monitor` exposes progress |
| Finished changes ready for GitHub                                   | `/yeet`                              | Repo-native verification and PR-template workflow                  |

A useful sequence for larger changes is:

```text
research → procedure → review loop → yeet
```

Each stage has a different trust boundary: external evidence, controlled implementation, independent verification, then publication.

## Command reference

| Command                      | Description                                                       |
| ---------------------------- | ----------------------------------------------------------------- |
| `/fast`                      | Toggle global Codex Fast Mode                                     |
| `/tool-search`               | Show available namespaced deferred-tool capabilities              |
| `/web-tools`                 | Open Firecrawl configuration                                      |
| `/web-tools status`          | Show key source, credits, active tools, budgets, and telemetry    |
| `/skill:research <question>` | Run the bundled evidence-grounded research workflow               |
| `/review [target]`           | Start an interactive review in an empty branch or current session |
| `/settings-review`           | Configure Review Loop mode, models, and convergence               |
| `/end-review`                | Return from an isolated review, optionally summarize or fix       |
| `/loop-review [target]`      | Run standard or parallel specialized review/fix loops             |
| `/proc <goal>`               | Generate, review, and launch an ephemeral procedure               |
| `/proc run <name> [goal]`    | Run a saved procedure                                             |
| `/proc save <run-id> [name]` | Promote an ephemeral run to `.pi/procedures/`                     |
| `/proc pause <run-id>`       | Pause new task scheduling                                         |
| `/proc resume <run-id>`      | Resume a paused run                                               |
| `/proc stop <run-id>`        | Stop an active run                                                |
| `/proc restart <run-id>`     | Start a terminal run again                                        |
| `/monitor [run-id]`          | Inspect and control procedure runs                                |
| `/yeet [instructions]`       | Publish appropriate work as one ready PR                          |

See each extension README for complete syntax, safety constraints, and troubleshooting.

## Configuration and persisted data

Defaults below assume Pi's standard agent directory, `~/.pi/agent`.

| Feature             | Location                                     | Contains                                                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Fast Mode           | `~/.pi/agent/fast-mode.json`                 | Global on/off state                                                 |
| Web Tools           | `~/.pi/agent/web.json`                       | Tool toggles, context limits, and credit guards                     |
| Firecrawl key       | macOS Keychain or `FIRECRAWL_API_KEY`        | API credential; environment takes precedence                        |
| Web telemetry       | `~/.pi/agent/web-telemetry.jsonl`            | Rotating privacy-safe operation metrics and input fingerprints      |
| Interactive review  | Current Pi session                           | Review-branch origin and custom instructions                        |
| Review loop         | `~/.pi/agent/review-loop.json`               | Role model references, reasoning, convergence, verification command |
| Procedure run store | `~/.pi/agent/procedure-runs/<project-hash>/` | Run snapshots and ephemeral generated source                        |
| Saved procedures    | `<project>/.pi/procedures/`                  | Explicitly promoted manifests and JavaScript source                 |

Credentials are not written into Review Loop settings or procedure definitions.

## Security model

These are trusted local extensions, not sandboxes around Pi itself.

- Pi extensions run with the user's process permissions.
- Web content, repository content, GitHub data, and model output are treated as untrusted data.
- Web Tools applies client-side URL checks, but the Firecrawl deployment must enforce private-network blocking at provider egress and on redirects.
- `/review pr` checks out a GitHub PR locally; `/loop-review` gives trusted reviewer models the user's active tools and general Bash while keeping fixer mutations guarded.
- Procedures isolate orchestration code in a bounded worker/VM, but source-declared child agents can edit files or run shell commands. Source review is the launch safety boundary.
- `/yeet` can create commits, push a branch, and open a public PR. It stops on suspicious files, likely secrets, destructive changes, or unrelated work.

Read the extension-specific safety section before enabling mutating or billed capabilities.

## Repository layout

```text
.
├── src/index.ts                    # Reserved workspace-wide extension entry point
├── extensions/
│   ├── fast-mode/                  # /fast
│   ├── tool-search/                # tool_search and capability registry
│   ├── web-tools/                  # web_* tools and research skill
│   ├── review/                     # /review, /end-review, /loop-review
│   └── procedures/                 # /proc, /monitor, procedure_status
├── prompt/yeet.md                  # /yeet prompt template
├── package.json                    # root Pi package manifest
└── pnpm-workspace.yaml             # extension workspace packages
```

## Development

Install dependencies once:

```bash
pnpm install
```

Run the complete workspace validation:

```bash
pnpm check
```

Common focused commands:

```bash
pnpm check:root
pnpm --filter pi-fast-mode check
pnpm --filter pi-tool-search check
pnpm --filter pi-web-tools check
pnpm --filter pi-review check
pnpm --filter pi-procedures check
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

- [Fast Mode](extensions/fast-mode/README.md)
- [Tool Search](extensions/tool-search/README.md)
- [Web Tools](extensions/web-tools/README.md)
- [Web Tools evaluations](extensions/web-tools/evals/README.md)
- [Research skill](extensions/web-tools/skills/research/SKILL.md)
- [Review](extensions/review/README.md)
- [Review Loop design plan](extensions/review/PLAN.md)
- [Procedures](extensions/procedures/README.md)
- [Procedure authoring guide](extensions/procedures/AUTHORING.md)
- [Procedure research/design rationale](extensions/procedures/RESEARCH.md)
- [Procedure manual QA](extensions/procedures/QA.md)
- [`/yeet` prompt](prompt/yeet.md)
