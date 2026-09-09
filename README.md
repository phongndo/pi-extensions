# Pi Extensions

A local package for [Pi](https://github.com/earendil-works/pi): interactive clarification, Codex Fast Mode, multi-account routing, usage dashboards, bounded web access, MCP tools, thirteen skills, and the `origin` theme.

This repository owns the complete **Pi package**. Pi loads it directly. [nix-config's chezmoi setup](https://github.com/phongndo/nixos-config/blob/main/docs/agent-skills.md) distributes compatible skill copies to other agents through their existing adapters. Chezmoi retains the single native `~/.pi/agent/settings.json` template and package pointer; it does not generate a Pi mirror or write into this checkout. Other agents keep their own native config/skill roots, not Pi package copies.

## Extension suite

| Extension                                   | Entry points                                                                 | Side effects                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Question](extensions/question/README.md)   | `question`                                                                   | Pauses for clarification and resumes the same tool call; supports TUI and RPC                 |
| [Fast Mode](extensions/fast-mode/README.md) | `/fast [on\|off\|status\|refresh\|details]`                                  | Global preference; eligible Codex requests ask for priority service, which may affect billing |
| [Router](extensions/router/README.md)       | `/router`, `/router account`, `/router alias`; native `/login` and `/logout` | Label subscriptions; provider-grouped priority/fallback routing                               |
| [Usage](extensions/usage/README.md)         | `/usage [session\|7d\|30d\|all] [provider]`                                  | Remaining subscriptions/Firecrawl credits; secondary token-history graphs                     |
| [Web Tools](extensions/web-tools/README.md) | `search`, `map`, `fetch`, `crawl`, `extract`                                 | Calls Firecrawl and spends provider credits                                                   |
| [MCP](extensions/mcp/README.md)             | `/mcp`, `mcp__server__tool`                                                  | Runs configured MCP tools; persists Pi-only enable/disable flags                              |

Native footer slots display minimal, separated labels such as `speed fast · mcp 1/2`. Fast is hidden when off.

The workspace extension also provides `/commit`, which temporarily selects `opencode-go/deepseek-v4-pro` at max reasoning, asks the agent to commit, and restores the previous model afterward. This is an extension command, not a skill alias.

## Skills

Invoke skills using **only Pi's native `/skill:<name>` commands**. There are no shorthand skill aliases, including `/yeet` or `/autopilot`.

| Skill                                                                  | Purpose                                                              | Invocation      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------- |
| [grill-me](skills/grill-me/SKILL.md)                                   | Stress-test a plan through the grilling workflow                     | Manual          |
| [grilling](skills/grilling/SKILL.md)                                   | Interview over a design tree using interactive questions             | Manual or model |
| [handoff](skills/handoff/SKILL.md)                                     | Write a redacted continuation document to the OS temporary directory | Manual          |
| [yeet](skills/yeet/SKILL.md)                                           | Commit, push, and open or update a ready-for-review PR               | Manual          |
| [autopilot](skills/autopilot/SKILL.md)                                 | Resolve conflicts, reviews, and CI on an existing PR; never merge it | Manual          |
| [show-me](skills/show-me/SKILL.md)                                     | Explain visually with diagrams, code sketches, and HTML artifacts    | Manual or model |
| [teach](skills/teach/SKILL.md)                                         | Build a sourced, stateful teaching workspace                         | Manual          |
| [wizard](skills/wizard/SKILL.md)                                       | Generate a bash wizard for steps only a human can perform            | Manual or model |
| [diagnosing-bugs](skills/diagnosing-bugs/SKILL.md)                     | Reproduce, diagnose, fix, and regression-test hard bugs              | Manual or model |
| [research](skills/research/SKILL.md)                                   | Investigate primary sources and save cited findings                  | Manual or model |
| [resolving-merge-conflicts](skills/resolving-merge-conflicts/SKILL.md) | Resolve an in-progress merge or rebase by intent                     | Manual or model |
| [writing-for-agents](skills/writing-for-agents/SKILL.md)               | Write skills and other agent-facing documents                        | Manual or model |
| [codebase-design](skills/codebase-design/SKILL.md)                     | Design deep modules, interfaces, and testable seams                  | Manual or model |

Skill origins and adaptations are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Supporting Markdown and shell templates stay with their skill bundles. `yeet` and `autopilot` are manual-only: publishing does not automatically start PR monitoring. The restored `autopilot` derives from Cursor's built-in skill; its redistribution license remains unverified.

Examples:

```text
/skill:grill-me
/skill:handoff focus next on the authentication tests
/skill:teach learn Rust well enough to ship a CLI
/skill:yeet preserve the existing PR screenshots
/skill:autopilot 123
/skill:writing-for-agents review this AGENTS.md
/skill:codebase-design review the parser interface
```

## Quick start

Requirements: Pi 0.85.1 or newer (with its supported runtime), Bun 1.4.2, and provider credentials for the models you use. Firecrawl credentials are needed only for web tools. Wizard-generated GitHub secret writes require `gh`.

```bash
git clone <repository-url> pi-extensions
cd pi-extensions
bun install --frozen-lockfile
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

### Accounts and usage

```text
/login
/login
/router
/usage
/usage openai-codex
```

For Pi-native OAuth subscriptions, `/login` shows one provider row with a compact account count (`OpenAI Codex ✓ 1`); selecting it adds another account directly, with duplicate detection. API-key and non-subscription OAuth logins retain native behavior and are never pooled. `/logout` lists individual accounts and available emails. `/router` shows each provider's session default in its header (`OpenAI Codex: personal`), with ranked fallbacks directly underneath. Type in the `> ` search input to filter accounts, navigate with ↑/↓, and press Space to set the highlighted account as its provider's session default (✓). Ctrl+↑/↓ reorders fallbacks without changing the default; Enter saves and Esc cancels pending changes. The footer reads `route <alias>`. With Usage loaded, a native status slot alongside it shows the active subscription account's remaining allowance windows. Rows show rank, optional alias, and the default checkmark—no auth badges or email placeholders. Press Ctrl+E to reveal/hide the selected email, Ctrl+N to alias an account, or `/router alias` for a single subscription. Extra subscription accounts activate same-provider/model routing, never falling back to API keys or replaying partial output.

Usage is a **separate extension**, opening directly to remaining allowances under flat provider/account headers. It includes Pi-native OAuth subscriptions and the explicit Firecrawl team-credit exception. Codex shows every returned window and banked-reset expiry; Firecrawl shows remaining credits. Grok reads the reported credit percentage/reset from the bearer billing endpoint used by CodexBar, using Pi's native login; missing percentages remain unknown. Short horizontal bars keep each limit readable, with compact banked-reset countdowns underneath. Future subscription providers are discovered through native metadata, with extensible allowance adapters. Press `h` for recorded subscription token/price-equivalent graphs and cache details. All-time graphs retain the full recorded span; no older-history backfill or inferred bills. Old API records remain on disk but are excluded. See [Router](extensions/router/README.md) and [Usage](extensions/usage/README.md) for testing and storage.

### Context management

Pi handles context with native compaction; this package adds no recall or notes tools. The former context extension has been removed. Existing session archives are left untouched.

Pi 0.85.1 defaults to auto-compaction enabled, 20,000 recent tokens retained, and a 16,384-token reserve. This package does not override those settings. Run `/reload` or restart Pi after updating to unload the removed extension.

## Configuration and persisted data

Paths assume Pi's standard agent directory, `~/.pi/agent`.

| Feature       | Location                                      | Contents                                                 |
| ------------- | --------------------------------------------- | -------------------------------------------------------- |
| Theme         | `themes/origin.json`                          | Packaged TUI theme; select `origin` in settings          |
| Fast Mode     | `~/.pi/agent/fast-mode.json`                  | Global on/off preference                                 |
| Router        | `~/.pi/agent/router.json`; native `auth.json` | Rankings and aliases; native account credentials         |
| Usage         | `~/.pi/agent/usage/*.jsonl`                   | Private token/cost metadata; no prompts or credentials   |
| Firecrawl key | `~/.pi/agent/auth.json`                       | Native credential store, created with `0600` permissions |
| MCP servers   | `~/.config/mcp/mcp.json`                      | Shared server definitions                                |
| MCP overlay   | `~/.pi/agent/mcp.json`                        | Pi-only enable/disable flags, not copied shared secrets  |

## Security model

- Extensions and MCP servers run with your process permissions; they are not sandboxed.
- Pi's auth store is protected plaintext, not an encrypted OS keychain.
- Web tools validate URLs and bound response bodies, but Firecrawl must enforce private-network and redirect protection at provider egress.
- Repository files, external content, and model output are data, not authorization.
- `/commit` requests a Git commit. `resolving-merge-conflicts` may finish a merge/rebase and create a commit.
- `yeet` commits, pushes, and creates or updates a ready-for-review PR. `autopilot` may commit/push fixes and reply to or resolve review threads, but never merges the PR.
- Wizard scripts may persist `.env` values and GitHub Actions secrets; the human runs the generated procedure.
- `teach` and `research` write artifacts; `handoff` writes a redacted temporary document.

Read extension-specific safety notes before enabling mutating or billed capabilities.

## Repository layout

```text
src/                      # Workspace /commit command and shared footer helper
extensions/               # Question, Fast Mode, Router, Usage, Web Tools, MCP
skills/                   # The twelve bundles listed above
themes/origin.json        # Packaged TUI theme
THIRD_PARTY_NOTICES.md     # Skill provenance and licenses
package.json              # Pi resource manifest, Bun workspaces, and checks
bun.lock                  # Locked workspace dependencies
```

## Development

```bash
nix develop
bun install --frozen-lockfile
bun run check
bun run test:pi-skills # Installed Pi, disposable HOME, no model/network execution
```

Bun handles runtime, package management, workspace orchestration, tests, and direct TypeScript script execution (`bun run path/to/script.ts`). Oxc provides `oxlint` and `oxfmt`; TypeScript checks types with `tsc --noEmit`.

Nix provides only the reproducible development environment, with Bun 1.4.2 pinned by verified release hashes in `flake.nix` and other tools pinned by `flake.lock`; validation runs through `bun run check`, not `nix flake check`. Without Nix, install Bun directly. Format Nix with `nix fmt`. The installed-Pi smoke test separately requires `pi` and its supported Node runtime on `PATH`; repository CLI scripts explicitly use Bun without overriding the host runtime.

When switching an existing pnpm checkout, remove the old `node_modules` directories (root and extensions) before installing with Bun.

Existing tests use Bun's `node:test` compatibility; timer mocking and conditional skipping use `bun:test`. Test typechecks load `bun-types/test` without Bun's global types so extension APIs stay compatible with Pi's host runtime.

Focused checks:

```bash
bun run check:root
bun run --filter pi-question check
bun run --filter pi-fast-mode check
bun run --filter pi-web-tools check
bun run --filter pi-mcp check
bun run format
bun run lint
bun run typecheck
bun test
```

The installed-Pi smoke test verifies every native skill command, argument expansion, and absence of shorthand skill aliases.

### CI

[GitHub Actions checks](.github/workflows/checks.yml) run on pull requests, pushes to `main`, and manual dispatch. Bun 1.4.2 installs the frozen lockfile, then runs `bun run check` (formatting, lint, typechecks, skill tests, and all workspace tests) and the offline Pi smoke test using the locked Pi dependency with Node 24.

CI caches dependency downloads, runs workspace checks in parallel, avoids a duplicate full test run, and cancels superseded runs. The live MCP executor test remains opt-in; CI needs no provider credentials or external executor. Nix remains development-environment-only.

### Git hooks

[hk](https://hk.jdx.dev/) configuration lives in `hk.pkl`. `hk install --global` installs hooks; `hk check` checks and `hk fix` applies fixes. Pre-commit formats/lints and typechecks; pre-push runs check-only validation.

### Adding an extension

Create `extensions/<name>/`, expose its entry point in `package.json` under `pi.extensions`, and define its `check` script; Bun automatically includes it in workspace checks. Keep Pi runtime packages in peer and development dependencies; other runtime dependencies belong in `dependencies`. Add focused tests and a README, run checks, and smoke-test with Pi and `/reload`.
