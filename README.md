# Pi Extensions

[Question](extensions/question/README.md), [Fast Mode](extensions/fast-mode/README.md), [Advisor](extensions/advisor/README.md), and themes for [Pi](https://github.com/earendil-works/pi).

Requires Pi 0.85.1+ and Bun 1.4.2 (`nix develop` provides Bun).

```bash
git clone https://github.com/phongndo/pi-extensions.git
cd pi-extensions
bun install --frozen-lockfile
pi install "$PWD"
```

Use `/fast` and `/advisor`. Run `/reload` after changes. Extension links above cover configuration.

For MCP, use [Pi's built-in support](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) (Pi 0.99.0+); this package does not provide an MCP extension.

## Claude Code provider patch

[`patches/pi-claude-cli.patch`](patches/pi-claude-cli.patch) teaches [dmmulroy/pi-claude-cli](https://github.com/dmmulroy/pi-claude-cli) (MIT) to take a speed, so `/fast` turns on Claude Code's [fast mode](https://code.claude.com/docs/en/fast-mode) for Fable 5.2, Opus 5.5 and Opus 5. It is made against upstream `802744c`; pin the source to that commit so package updates keep it:

```bash
pi install git:github.com/dmmulroy/pi-claude-cli@802744c4426e9f4e7372e9fb9d962ba1654565fe
patches/apply-pi-claude-cli.sh   # pi's checkout by default, or pass a checkout path
```

Then `/reload`. The script leaves an applied patch alone and never resets or cleans the checkout. A package update may restore the checkout: run it again afterwards. To move to a newer upstream, apply the patch there, fix conflicts, and regenerate it with `git diff` (new files included) in that checkout. The patch also carries its own stub scenarios and tests; run them with upstream's toolchain (`vp`, see its README).

On a Claude subscription Fast mode is billed to usage credits from the first token, even with plan allowance left.

## Themes

Select `origin`, `github-dark-high-contrast`, `rex-static-noir`, or `rex-merino-light` in `/settings`. `github-dark-high-contrast` uses GitHub's Primer palette and leaves every background to the terminal. The Rex themes use the app's bundled sRGB palette, with small contrast adjustments for Pi's text roles. The terminal still draws the base background.

To switch between Merino Light and Static Noir with the terminal's appearance, set this in `~/.pi/agent/settings.json`:

```json
{
  "theme": "rex-merino-light/rex-static-noir"
}
```

Run `/reload` to pick up the change.

## Checks

```bash
nix develop --command bun run check
```

Extensions run with your permissions; Fast Mode and Advisor can incur charges.
