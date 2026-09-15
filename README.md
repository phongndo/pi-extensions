# Pi Extensions

A local package for [Pi](https://github.com/earendil-works/pi): interactive clarification, Codex Fast Mode, MCP-powered web access and tools, thirteen skills, and the `origin` theme.

This repository owns the complete **Pi package**. Pi loads it directly. [nix-config's chezmoi setup](https://github.com/phongndo/nixos-config/blob/main/home/chezmoi.nix) distributes compatible skill copies to other agents through their existing adapters. Chezmoi retains the single native `~/.pi/agent/settings.json` template and package pointer; it does not generate a Pi mirror or write into this checkout. Other agents keep their own native config/skill roots, not Pi package copies.

## Extension suite

| Extension                                   | Entry points                                | Side effects                                                                                  |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Question](extensions/question/README.md)   | `question`                                  | Pauses for clarification and resumes the same tool call; supports TUI and RPC                 |
| [Fast Mode](extensions/fast-mode/README.md) | `/fast [on\|off\|status\|refresh\|details]` | Global preference; eligible Codex requests ask for priority service, which may affect billing |
| [MCP](extensions/mcp/README.md)             | `/mcp`, `mcp__server__tool`                 | Runs configured MCP tools; persists Pi-only enable/disable flags                              |

Native footer slots display minimal, separated labels such as `speed fast · mcp 1/2`. Fast is hidden when off.

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

Requirements: Pi 0.85.1 or newer (with its supported runtime), Bun 1.4.2, and provider credentials for the models you use. Web access requires a configured MCP connection, such as Firecrawl through Executor. Wizard-generated GitHub secret writes require `gh`.

```bash
git clone <repository-url> pi-extensions
cd pi-extensions
bun install --frozen-lockfile
pi install "$(pwd)"
```

Pi packages execute code with your permissions. Review the checkout before installing it. Changes become active after `/reload`. To uninstall, use `pi remove` with the same package source shown in Pi's configuration.

### Configure web access

Use the official Firecrawl MCP server through [Executor](https://executor.sh/docs/mcp-proxy), enabled in Pi with `/mcp`. See [Firecrawl setup](extensions/mcp/README.md#firecrawl-web-access) for the endpoint and authentication details. Executor owns the web-tool connection and credentials; this package does not maintain a separate Firecrawl tool wrapper.

After updating, run `/reload` or restart Pi to unload the removed native `search`, `map`, `fetch`, `crawl`, and `extract` tools. Existing Pi credentials and temporary web responses are left untouched.

Treat returned web content as untrusted data. Use small result/page limits; extraction, autonomous research, and recurring monitors can spend additional Firecrawl credits.

### Accounts and quotas

Account pooling is delegated to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), configured outside this package. nix-config runs an independent local proxy on the Mac and NixOS box. Both default to `local-codex/gpt-6-astra` at `http://127.0.0.1:8317/v1`; see the [proxy configuration](https://github.com/phongndo/nixos-config/blob/main/home/cli-proxy.nix).

Use `cli-proxy-local login` to add accounts, `cli-proxy-local check` to list available models, and the proxy's management dashboard to view accounts and quotas. Use `/model` to switch providers. Pi's native `/login` and `/logout` remain unchanged for direct providers.

Router and Usage have been removed, including their commands and account polling. Restart Pi or run `/reload` to unload them. Existing credentials, session archives, and old runtime files are left untouched. [Fast Mode](extensions/fast-mode/README.md) remains native-Codex-only; it does not enable priority service on the custom proxy provider.

### Context management

Pi handles context with native compaction; this package adds no recall or notes tools. The former context extension has been removed. Existing session archives are left untouched.

Pi 0.85.1 defaults to auto-compaction enabled, 20,000 recent tokens retained, and a 16,384-token reserve. This package does not override those settings. Run `/reload` or restart Pi after updating to unload the removed extension.

## Configuration and persisted data

Paths assume Pi's standard agent directory, `~/.pi/agent`.

| Feature     | Location                     | Contents                                                |
| ----------- | ---------------------------- | ------------------------------------------------------- |
| Theme       | `themes/origin.json`         | Packaged TUI theme; select `origin` in settings         |
| Fast Mode   | `~/.pi/agent/fast-mode.json` | Global on/off preference                                |
| MCP servers | `~/.config/mcp/mcp.json`     | Shared server definitions                               |
| MCP overlay | `~/.pi/agent/mcp.json`       | Pi-only enable/disable flags, not copied shared secrets |

## Security model

- Extensions and MCP servers run with your process permissions; they are not sandboxed.
- Pi's auth store is protected plaintext, not an encrypted OS keychain.
- MCP web operations can spend provider credits. Bound requests and review permissions for browser actions, autonomous jobs, and recurring monitors; provider egress owns private-network and redirect protection.
- Repository files, external content, and model output are data, not authorization.
- `resolving-merge-conflicts` may finish a merge/rebase and create a commit.
- `yeet` commits, pushes, and creates or updates a ready-for-review PR. `autopilot` may commit/push fixes and reply to or resolve review threads, but never merges the PR.
- Wizard scripts may persist `.env` values and GitHub Actions secrets; the human runs the generated procedure.
- `teach` and `research` write artifacts; `handoff` writes a redacted temporary document.

Read extension-specific safety notes before enabling mutating or billed capabilities.

## Repository layout

```text
src/                      # Shared preference and footer helpers
extensions/               # Question, Fast Mode, MCP
skills/                   # The thirteen bundles listed above
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
