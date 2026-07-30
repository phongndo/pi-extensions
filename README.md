# Pi extensions

Personal Pi extensions developed as a pnpm workspace and loaded through one
local Pi package.

## Extensions

- `src/index.ts` — workspace status command (`/extension-dev-status`)
- `extensions/fast-mode/` — global Codex Fast mode toggle (`/fast`)
- `extensions/web-tools/` — Firecrawl web tools, configuration command
  (`/web-tools`), and the bundled `research` skill
- `extensions/review-loop/` — bounded independent review/fix/re-review loop
  (`/loop-review`)
- `prompt/yeet.md` — publish the current work as a ready pull request (`/yeet`)

## Commands

```bash
pnpm check          # oxformat check, oxlint, and TypeScript
pnpm format         # apply oxformat
pnpm lint           # run oxlint
pnpm lint:fix       # apply safe oxlint fixes
pnpm typecheck      # TypeScript only
pnpm lsp            # stdio TypeScript language server
```

## Git hooks

This repo uses [hk](https://hk.jdx.dev/) (`hk.pkl`). With global hk hooks
installed (`hk install --global`), pre-commit/pre-push run automatically:

- **pre-commit** — fix with oxfmt + oxlint, then typecheck with `tsc`
- **pre-push** — check-only (same tools)

Manual runs:

```bash
hk check            # or: mise run check
hk fix              # or: mise run fix
hk run pre-commit
```

Pi loads this checkout as a local package. After changing an extension, run
`/reload` in Pi. Use `/extension-dev-status` to confirm that it loaded.

Add extension packages under `extensions/`, include them in
`pnpm-workspace.yaml`, and expose their resources through the root `pi` manifest
in `package.json`.

Pi framework packages belong in both `peerDependencies` (runtime contract) and
`devDependencies` (local editor and type-checking support). Other runtime
libraries belong in `dependencies`; developer tooling belongs in
`devDependencies`.
