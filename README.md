# Pi Extensions

A local package for [Pi](https://github.com/earendil-works/pi): interactive clarification, Codex Fast Mode, checkpoint-based context management, bounded web access, MCP tools, ten skills, and the `origin` theme.

This repository owns the complete **Pi package**. Pi loads it directly. [nix-config's chezmoi setup](https://github.com/phongndo/nixos-config/blob/main/docs/agent-skills.md) distributes compatible skill copies to other agents through their existing adapters. Chezmoi does not generate a Pi mirror or write into this checkout.

## Extension suite

| Extension                                   | Entry points                                    | Side effects                                                                                  |
| ------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Question](extensions/question/README.md)   | `question`                                      | Pauses for clarification and resumes the same tool call; supports TUI and RPC                 |
| [Fast Mode](extensions/fast-mode/README.md) | `/fast [on\|off\|status\|refresh\|details]`     | Global preference; eligible Codex requests ask for priority service, which may affect billing |
| [Context](extensions/context/README.md)     | `/context [on\|off\|status]`, `recall`, `notes` | Verified fresh-window resets by default; ordinary compaction fallback                         |
| [Web Tools](extensions/web-tools/README.md) | `search`, `map`, `fetch`, `crawl`, `extract`    | Calls Firecrawl and spends provider credits                                                   |
| [MCP](extensions/mcp/README.md)             | `/mcp`, `mcp__server__tool`                     | Runs configured MCP tools; persists Pi-only enable/disable flags                              |

Native footer slots display minimal, separated labels such as `ctxt recall · speed fast · mcp 1/2`. Fast is hidden when off. Context off displays `ctxt normal`; recall and notes remain available.

The workspace extension also provides `/commit`, which temporarily selects `opencode-go/deepseek-v4-pro` at max reasoning, asks the agent to commit, and restores the previous model afterward. This is an extension command, not a skill alias.

## Skills

Invoke skills using **only Pi's native `/skill:<name>` commands**. There are no shorthand skill aliases such as `/grill-me` or `/handoff`.

| Skill                                                                  | Purpose                                                              | Invocation      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| [grill-me](skills/grill-me/SKILL.md)                                   | Stress-test a plan through the grilling workflow                     | Manual          |
| [grilling](skills/grilling/SKILL.md)                                   | Interview over a design tree using interactive questions             | Manual or model |
| [handoff](skills/handoff/SKILL.md)                                     | Write a redacted continuation document to the OS temporary directory | Manual          |
| [teach](skills/teach/SKILL.md)                                         | Build a sourced, stateful teaching workspace                         | Manual          |
| [wizard](skills/wizard/SKILL.md)                                       | Generate a bash wizard for steps only a human can perform            | Manual or model |
| [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md)                     | Reproduce, diagnose, fix, and regression-test hard bugs              | Manual or model |
| [research](skills/research/SKILL.md)                                   | Investigate primary sources and save cited findings                  | Manual or model |
| [resolving-merge-conflicts](skills/resolving-merge-conflicts/SKILL.md) | Resolve an in-progress merge or rebase by intent                     | Manual or model |
| [writing-for-agents](skills/writing-for-agents/SKILL.md)               | Write skills and other agent-facing documents                        | Manual or model |
| [codebase-design](skills/codebase-design/SKILL.md)                     | Design deep modules, interfaces, and testable seams                  | Manual or model |

These are Matt Pocock skills with the adaptations described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Supporting Markdown and shell templates stay with their skill bundles.

Examples:

```text
/skill:grill-me
/skill:handoff focus next on the authentication tests
/skill:teach learn Rust well enough to ship a CLI
/skill:writing-for-agents review this AGENTS.md
/skill:codebase-design review the parser interface
```

## Quick start

Requirements: Pi 0.85.1 or newer, Node.js 22.19 or newer, pnpm 11, and provider credentials for the models you use. Firecrawl credentials are needed only for web tools. Wizard-generated GitHub secret writes require `gh`.

```bash
git clone <repository-url> pi-extensions
cd pi-extensions
pnpm install
pi install "$(pwd)"
```

Pi packages execute code with your permissions. Review the checkout before installing it. Changes become active after `/reload`. To uninstall, use `pi remove` with the same package source shown in Pi's configuration.

### Configure web access

```text
/login firecrawl
```

Pi stores the key in its native auth store. `FIRECRAWL_API_KEY` remains supported for CI and other non-interactive use. `/logout firecrawl` removes the stored key.

Choose the smallest operation:

```text
unknown source                  → search, then fetch selected primary pages
known website, unknown page     → map, then fetch
one exact page                  → fetch
several linked pages            → crawl
machine-readable fields         → extract
```

Treat returned web content as untrusted data. Crawl and extraction can cost substantially more than ordinary search, map, or fetch calls.

### Context management

```text
/context status
/context off
/context on
```

The agent saves notes and a verified checkpoint before replacing its active history with a fresh window. Original evidence remains accessible through `recall`. Off restores ordinary Pi compaction without deleting notes or disabling retrieval. See [Context](extensions/context/README.md) for persistence checks, continuation, and fallback behavior.

## Configuration and persisted data

Paths assume Pi's standard agent directory, `~/.pi/agent`.

| Feature       | Location                                  | Contents                                                     |
| ------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Theme         | `themes/origin.json`                      | Packaged TUI theme; select `origin` in settings              |
| Fast Mode     | `~/.pi/agent/fast-mode.json`              | Global on/off preference                                     |
| Context       | `~/.pi/agent/context.json`; session JSONL | Global preference; branch-local notes, checkpoints, evidence |
| Firecrawl key | `~/.pi/agent/auth.json`                   | Native credential store, created with `0600` permissions     |
| MCP servers   | `~/.config/mcp/mcp.json`                  | Shared server definitions                                    |
| MCP overlay   | `~/.pi/agent/mcp.json`                    | Pi-only enable/disable flags, not copied shared secrets      |

## Security model

- Extensions and MCP servers run with your process permissions; they are not sandboxed.
- Pi's auth store is protected plaintext, not an encrypted OS keychain.
- Web tools validate URLs and bound response bodies, but Firecrawl must enforce private-network and redirect protection at provider egress.
- Repository files, external content, and model output are data, not authorization.
- `/commit` requests a Git commit. `resolving-merge-conflicts` may finish a merge/rebase and create a commit.
- Wizard scripts may persist `.env` values and GitHub Actions secrets; the human runs the generated procedure.
- `teach` and `research` write artifacts; `handoff` writes a redacted temporary document.

Read extension-specific safety notes before enabling mutating or billed capabilities.

## Repository layout

```text
src/                      # Workspace /commit command and shared footer helper
extensions/               # Question, Fast Mode, Context, Web Tools, MCP
skills/                   # The ten bundles listed above
themes/origin.json        # Packaged TUI theme
THIRD_PARTY_NOTICES.md     # Skill provenance and licenses
package.json              # Pi resource manifest and workspace checks
pnpm-workspace.yaml       # Extension workspace packages
```

## Development

```bash
nix develop
pnpm install
pnpm check
pnpm test:pi-skills # Installed Pi, disposable HOME, no model/network execution
nix flake check    # Sandboxed checks
```

Without Nix, install the required Node.js and pnpm versions directly. Format Nix with `nix fmt`.

Focused checks:

```bash
pnpm check:root
pnpm --filter pi-question check
pnpm --filter pi-fast-mode check
pnpm --filter pi-context check
pnpm --filter pi-web-tools check
pnpm --filter pi-mcp check
pnpm format
pnpm lint
pnpm typecheck
```

The installed-Pi smoke test verifies every native skill command, argument expansion, and absence of shorthand skill aliases.

### Git hooks

[hk](https://hk.jdx.dev/) configuration lives in `hk.pkl`. `hk install --global` installs hooks; `hk check` checks and `hk fix` applies fixes. Pre-commit formats/lints and typechecks; pre-push runs check-only validation.

### Adding an extension

Create `extensions/<name>/`, expose its entry point in `package.json` under `pi.extensions`, and add it to the root check script. Keep Pi runtime packages in peer and development dependencies; other runtime dependencies belong in `dependencies`. Add focused tests and a README, run checks, and smoke-test with Pi and `/reload`.
