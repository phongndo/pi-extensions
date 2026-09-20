# Pi Extensions

[Question](extensions/question/README.md), [Fast Mode](extensions/fast-mode/README.md), [MCP](extensions/mcp/README.md), [skills](skills/), and the `origin` theme for [Pi](https://github.com/earendil-works/pi).

Requires Pi 0.85.1+ and Bun 1.4.2 (`nix develop` provides Bun).

```bash
git clone https://github.com/phongndo/pi-extensions.git
cd pi-extensions
bun install --frozen-lockfile
pi install "$PWD"
```

Use `/fast`, `/mcp`, and `/skill:<name>`. Run `/reload` after changes. Extension links above cover configuration.

Checks:

```bash
nix develop --command bun run check
```

Extensions run with your permissions; Fast Mode and MCP tools can incur charges.

[Third-party notices](THIRD_PARTY_NOTICES.md).
