# Agent skills: ownership and portability audit

## Architecture

`~/code/pi-extensions/skills` is the only content source. Pi loads this checkout as **one package**; its explicit manifest registers five extension entry points, one skills root (17 skills), and one themes root (`origin`). The local Pi settings and chezmoi template already had the correct package entry and `enableSkillCommands: true`; neither needed changing. There were no package mirrors in `~/.pi/agent/skills` or `~/.agents/skills`. The separate global `herdr-agent-state.ts` extension is unrelated and is left alone.

Before: chezmoi blindly deleted each matching destination directory and copied the Pi-adapted tree to five agents. It did not track ownership, remove deleted skills, preserve notices outside skill folders, or translate invocation policy. Cursor additionally discovered the Codex and Grok copies. Several old copies differed from the source only by formatter changes.

After:

```text
pi-extensions/skills (canonical portable instructions + supporting files)
  ├─ Pi package loader → /skill:<name>, with five thin direct aliases
  └─ chezmoi's sync-agent-skills + targets.json
       ├─ Codex copies + invocation-policy sidecars → also read by Cursor
       ├─ Copilot copies
       ├─ OpenCode copies + explicit-request instruction guard
       ├─ Grok copies
       └─ DeepSeek Harness copies
```

No symlinks, generated Pi mirror, new plugin manager, or checked-in target skill trees. Chezmoi owns the executable, target/adapters table, and a fixed **hash-only** legacy migration allowlist. Every installed skill carries `THIRD_PARTY_NOTICES.md` and `LICENSE`. Runtime files are never distribution inputs.

## Verified native contracts

Versions inspected: Pi **0.85.1**, Codex **0.153.4**, Cursor Agent **2026.09.02-c22c1a3**, Copilot CLI **1.0.83**, OpenCode **1.18.29**, Grok **1.0.13**, DeepSeek Harness **0.1.1-rc.2**. All seven are installed and configured in the actual nix-config checkout. DSH was found in chezmoi's mise configuration. Claude Code is not installed or managed; an old `~/.claude/debug` directory is not evidence of an active target. `co` is Origin's Git CLI, not another skill-consuming agent.

| Agent            | Installation used                                                               | Invocation                                           | Other discovery roots / duplicate risk                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pi               | `~/code/pi-extensions/skills` through `pi.skills`                               | `/skill:name`; descriptions for automatic skills     | `~/.pi/agent/skills`, `~/.agents/skills`, trusted project `.pi`/`.agents`, explicit settings/CLI paths, packages                                                                                                                                             |
| Codex            | `~/.codex/skills/<name>/SKILL.md`                                               | `$name` or `/skills`                                 | Also `~/.agents/skills`, repository ancestor `.agents/skills`, admin `/etc/codex/skills`, bundled/plugin skills. Native `skills/list` confirms this installed version still loads `.codex/skills`, though current docs primarily advertise `.agents/skills`. |
| Cursor           | Reads the **Codex installation**; no additional managed `.cursor/skills` mirror | `/name`                                              | Native user root is `~/.cursor/skills`; compatibility scans also include `.claude`, `.codex`, **`.grok`**, `.agents`, and built-in `~/.cursor/skills-cursor`. See limitation below.                                                                          |
| Copilot CLI      | `~/.copilot/skills/<name>/SKILL.md`                                             | `/name`; `/skills list`                              | Also `~/.agents/skills`, project `.github`/`.claude`/`.agents`, custom locations, plugins                                                                                                                                                                    |
| OpenCode         | `~/.config/opencode/skills/<name>/SKILL.md`                                     | Native `skill({ name })` tool; ask to invoke by name | Also `.claude/skills`, `.agents/skills`, project `.opencode/skills`, configured paths. Unknown frontmatter fields are ignored.                                                                                                                               |
| Grok             | `~/.grok/skills/<name>/SKILL.md`                                                | `/name`, `/skills`                                   | Project ancestor `.grok`, Claude-compatible roots, `~/.agents/skills`, plugins, `[skills] paths`                                                                                                                                                             |
| DeepSeek Harness | `~/.dsh/skills/<name>/SKILL.md`                                                 | Human skill commands / model `skill(name)` loader    | Project `.dsh`/`.agents`, custom roots, `~/.agents/skills`; user root respects `DSH_HOME`                                                                                                                                                                    |

All seven support a skill directory with `SKILL.md` plus nested supporting resources. DSH discovers only direct child skill bundles (not nested groups of skill bundles), which matches this layout. No destination is `~/.agents/skills`, because Pi would load a second copy. `/skill:name` is Pi syntax, not a portable cross-agent instruction. OpenCode skills are not custom slash-command definitions.

This configuration targets the default user homes above; nondefault `CODEX_HOME`, `DSH_HOME`, or XDG config layouts require changing the **single target table**. No existing credential/config files are relocated to obtain isolation.

### Symlink evidence

All outputs are regular copies regardless of support. Disposable native-discovery probes found:

- Codex follows directory symlinks but **ignores a symlinked `SKILL.md`**.
- Copilot, OpenCode, and Grok discovered both directory and `SKILL.md` symlinks.
- Cursor's installed `index.js` skill walker explicitly `stat`s symlink entries and tracks real directories to avoid cycles.
- DSH's installed `dsh-skill-filesystem/lib/index.js` `nodeEntryKind` follows symlinks using `stat`; its filesystem-service backend can impose different policies.
- Pi's installed-version SDK skill walker follows symlinks. No installation here relies on it.

### Cursor: remaining isolation limitation

The installed Cursor CLI has no supported user configuration switch to turn off compatibility discovery. Its skill merge code normalizes `.cursor/skills`, `.codex/skills`, and `.grok/skills` paths to the same home-relative key, so ordinary matching copies collapse; Codex precedes Grok. Installing another Cursor mirror adds no value. Removing the old **exact-match managed** Cursor copies leaves the Codex copy as the first compatible source.

Cursor also ships `skills-cursor/autopilot`, which has a different merge key. Its slash-command skill map is keyed by name, but its model resource catalog can retain both the bundled and personal autopilot. **Full zero-duplicate Cursor discovery is not achieved.** Do not delete or modify Cursor's bundled files: it owns and refreshes them. Cursor UI/cloud skill synchronization also only syncs `~/.cursor/skills`, so these compatibility-loaded personal skills are local, not automatically cloud-synced.

The user requested that Codex retain `autopilot`, declined renaming it to `pr-autopilot`, and preferred isolated configuration over Cursor's installed-version `metadata.surfaces` filtering. Relocating Codex auth/config, adding unsupported configuration keys, or using hidden-folder tricks would violate that preference or the minimal/native architecture. Therefore this limitation is explicit, rather than claiming unsupported isolation. A future supported Cursor CLI isolation switch would allow independent native Cursor installation without this exception.

## Skill classification

Classification of the audited input, before portability edits:

| Class                         | Skills                                                                                                              | Required change                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — neutral body              | `autopilot`, `bro`, `diagnosing-bugs`, `domain-modeling`, `prototype`, `resolving-merge-conflicts`, `teach`, `yeet` | No workflow changes. Manual-only metadata needs Codex/OpenCode adapters. Agent names in yeet's public-output prohibition are intentional, not tool assumptions.                                                                          |
| 2 — invocation wording        | `grill-me`, `grill-with-docs`, `handoff`, `setup-matt-pocock-skills`, `wayfinder`, `wizard`                         | Semantic skill names replace Pi commands, including setup reference templates and wizard's generated-by comment.                                                                                                                         |
| 3 — genuinely Pi-only         | None                                                                                                                | No skill needs exclusion from other agents.                                                                                                                                                                                              |
| 4 — tool/platform assumptions | `grilling`, `research`, `show-me`                                                                                   | Use available interactive questions/web tools/shell opener. Grilling preserves the frontier, up-to-four related questions, recommendation, fact/decision separation, and final human confirmation; respects smaller target batch limits. |

After these edits, **bodies need no target-specific rewriting**. Canonical dependency instructions say to invoke named skills; Pi's ordinary skill-reading behavior understands this without baked-in slash strings. All supporting resources survive byte-for-byte copying.

Manual-only skills remain manual via Pi/Cursor/Grok/DSH metadata. Codex receives `agents/openai.yaml` with `policy.allow_implicit_invocation: false` for each manual skill. OpenCode does not implement `disable-model-invocation`: its adapter prefixes the description and body with an explicit-request guard. **That is a model instruction, not enforced access control.** Copilot receives the existing invocation metadata; its discovery command does not expose whether automatic-invocation suppression is enforced. Do not claim a tested runtime permission boundary there.

Matt Pocock's plan-not-do, one-ticket-per-session (research exception), HITL/AFK separation, claim-before-work, tracker relationships, and non-nested research semantics are unchanged. Wayfinder still requires subagents for parallel research; agents without that capability must report the limitation rather than impersonate human participants or silently change the workflow.

`autopilot` provenance is now attributed to Cursor, not presented as independently authored or covered by Matt Pocock's MIT license. Its original revision and redistribution license are unverified; review before publishing this personal bundle.

## Pi aliases

`src/skill-aliases.ts` contains one five-entry map: `/wayfinder`, `/grill-me`, `/handoff`, `/autopilot`, `/yeet`. Each registered command checks that the native skill command exists, then calls supported `sendUserMessage` with `expandPromptTemplates: true`, forwarding arguments and using follow-up delivery if busy. Pi expands the **same canonical skill**; no duplicate prompt/skill file or second implementation exists. `/skill:name` remains available for all 17 packaged skills. Pi 0.85.1 is required; the root SDK dependencies were aligned with that installed API.

## Updates and safety

```sh
cd ~/code/pi-extensions
git pull
# edit skills; git add any NEW skill/supporting files after review
chezmoi apply
# optional focused loop (after installing the chezmoi-owned command once):
sync-agent-skills --dry-run
sync-agent-skills
```

The source checkout must exist; otherwise reconciliation prints a useful message and does not remove destinations. Agents need not yet be installed: distribution prepares their configured skill directories before mise installation. A missing Python interpreter is an actionable error, not silent success.

Only Git-tracked skill files are eligible, but current working-tree edits are used. Unknown/untracked files fail validation instead of being swept into distribution; secrets/runtime paths, symlinks, nested skill definitions, missing `SKILL.md`, duplicate names, and Pi-only invocation syntax fail before writes. Tracking is a boundary, not a secret scanner: review new files before `git add`.

All destinations are preflighted before any are changed. Ownership is recorded per skill as file hashes in `.pi-extensions-skills.json`. Matching legacy hashes authorize adoption; a name alone never does. Modified managed copies, added supporting files, and unowned name collisions are preserved with errors. Stale managed files are individually unlinked and only empty directories removed. There is no recursive destination delete. A process lock serializes runs; files and manifests use atomic replacement. A crash mid-skill can leave a partial copy, which the next run refuses to overwrite: move that reported skill aside or restore it before retrying. This is fail-closed, not a transactional filesystem or security sandbox against concurrent hostile mutation.

## Validation evidence

- `pnpm check`: passed (format, lint, typecheck, new canonical tests, existing extension checks/tests).
- `pnpm test:pi-skills`: passed against installed **Pi 0.85.1** in a disposable HOME. All 17 commands appeared once; all five aliases produced byte-identical expanded prompts to native commands, including arguments and canonical base paths. A deliberately failing in-process test provider prevented all model execution/network requests. This proves dispatch, not model compliance with workflows.
- Dotfiles: seven fixture tests pass, covering first install, idempotence including unchanged mtimes, updates, rename/deletion, nested files, notices, adapters, collisions, missing source, spaces, symlinks, and safe legacy cleanup. Run `python3 -B -m unittest discover -s tests -p test_agent_skills.py -v` from nix-config.
- Full canonical rendering to a temporary HOME: native Codex `app-server` `skills/list`, `copilot skill list --json`, `opencode debug skill`, and `grok inspect --json` each discovered **17 distinct managed skills**. OpenCode output was redirected to a regular file to avoid its truncated piped output. Codex's list response does not expose invocation policy; the rendered sidecar was inspected against the official schema.
- Cursor: installed-code discovery/merge contract inspected; no native CLI list command. DSH: installed provider documentation/source and rendered layout inspected; no model session was run.
- `nix flake check --all-systems --no-build`: passed. Both `git diff --check`: passed.
- `chezmoi diff`: passed; reports unrelated existing live drift in Codex, mise, OpenCode, and Pi settings. Ordinary `chezmoi apply --dry-run` could not prompt for that pre-existing drift without a TTY. Safe equivalent `chezmoi apply --dry-run --force`: passed. **No live apply or live skill reconciliation was performed.** Existing live configuration changes were not overwritten. Review that drift before an actual whole-machine apply.

## Primary sources

- [Pi skills](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/skills.md), [packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md), [extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md): audited against the complete locally installed 0.85.1 docs, not just current web versions.
- [OpenAI skills](https://developers.openai.com/codex/skills/) (redirects to current ChatGPT Learn skill docs); [Codex discovery implementation](https://github.com/openai/codex/tree/main/codex-rs/ext/skills/src/loader); installed `skills/list` establishes legacy `.codex/skills` behavior.
- [Cursor skills](https://cursor.com/docs/skills); installed `index.js` (`qr`, `ai`, `ui`, `di`, `MergedAgentSkillsService`) and `7932.index.js` (slash-command skill map) establish the extra Grok scan and deduplication limits.
- [Copilot CLI skill installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills).
- [OpenCode skills](https://opencode.ai/docs/skills/).
- [Grok skills/plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces).
- DSH's installed `@deepseek-ai/dsh-skill-filesystem/README.md` and `lib/index.js`, under the configured `@deepseek-ai/dsh@0.1.1-rc.2` installation, plus the code preset's `agent.cordis.yml`. These directly document root ranking, supporting files, invocation policy, and symlink handling.
