# Pi Extensions

[Question](extensions/question/README.md), [Fast Mode](extensions/fast-mode/README.md), and the `origin` theme for [Pi](https://github.com/earendil-works/pi).

Requires Pi 1.4.0+ and Bun 1.4.2 (`nix develop` provides Bun).

```bash
git clone https://github.com/phongndo/pi-extensions.git
cd pi-extensions
bun install --frozen-lockfile
pi install "$PWD"
```

Use `/fast`. Run `/reload` after changes. Extension links above cover configuration.

For MCP, use [Pi's built-in support](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) (Pi 0.99.0+); this package does not provide an MCP extension.

Checks:

```bash
nix develop --command bun run check
```

Extensions run with your permissions; Fast Mode can incur charges.
