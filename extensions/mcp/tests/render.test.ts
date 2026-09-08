import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderMcpCall, renderMcpResult } from "../render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const options = { expanded: false, isPartial: false };
const text = (value: string) => ({ content: [{ type: "text", text: value }] });

test("MCP headers identify server/tool and preview arguments, with full args on expand", () => {
  const args = { query: "native tools", limit: 10, nested: { enabled: true } };
  const compact = renderMcpCall("search", "find", args, theme).render(120).join("\n");
  assert.match(compact, /search \/ find query=native tools · limit=10 · \+1 args/);
  const expanded = renderMcpCall("search", "find", args, theme, true).render(120).join("\n");
  assert.match(expanded, /"enabled": true/);
  assert.match(
    renderMcpCall("search", "find", undefined, theme).render(80).join("\n"),
    /search \/ find/,
  );
});

test("structured results have readable previews and fully formatted expanded JSON", () => {
  const result = text(
    JSON.stringify({ count: 2, items: [{ title: "First" }, { title: "Second" }] }),
  );
  const before = JSON.stringify(result);
  const compact = renderMcpResult(result, options, theme).render(100).join("\n");
  assert.match(compact, /count: 2\nitems: \[2 items\]/);
  assert.match(compact, /to expand/);
  assert.doesNotMatch(compact, /Second/);
  const expanded = renderMcpResult(result, { ...options, expanded: true }, theme)
    .render(100)
    .join("\n");
  assert.match(expanded, /"title": "Second"/);
  assert.equal(JSON.stringify(result), before);
  for (const value of ["{}", "[]", "null", "42"])
    assert.ok(renderMcpResult(text(value), options, theme).render(100).join("\n").includes(value));
});

test("JSON presentation preserves numeric lexemes instead of rounding them", () => {
  for (const raw of [
    '{"id":9007199254740993}',
    '{"value":1e400}',
    '{"value":0.123456789012345678901}',
  ]) {
    const token = raw.slice(raw.indexOf(":") + 1, -1);
    for (const expanded of [false, true]) {
      const output = renderMcpResult(text(raw), { ...options, expanded }, theme)
        .render(120)
        .join("\n");
      assert.ok(output.includes(token), output);
    }
  }
});

test("deep JSON formatting has bounded whitespace amplification", () => {
  const raw = "[".repeat(200) + "0" + "]".repeat(200);
  const output = renderMcpResult(text(raw), { ...options, expanded: true }, theme)
    .render(120)
    .join("\n");
  assert.ok(
    output.length < raw.length * 8,
    `formatted ${raw.length} characters into ${output.length}`,
  );
});

test("text previews are bounded by physical lines, with long single-line content expandable", () => {
  const result = text(Array.from({ length: 15 }, (_, i) => `line-${i}`).join("\n"));
  const compact = renderMcpResult(result, options, theme).render(80).join("\n");
  assert.match(compact, /11 more lines/);
  assert.doesNotMatch(compact, /line-14/);
  assert.match(
    renderMcpResult(result, { ...options, expanded: true }, theme)
      .render(80)
      .join("\n"),
    /line-14/,
  );
  assert.match(
    renderMcpResult(text("x".repeat(1000)), options, theme)
      .render(60)
      .join("\n"),
    /to expand/,
  );
});

test("errors, truncation paths, pending results, and images survive presentation", () => {
  const result = { ...text("x\n".repeat(10)), details: { fullOutputPath: "/tmp/full-output.txt" } };
  assert.match(
    renderMcpResult(result, options, theme).render(100).join("\n"),
    /full output: \/tmp\/full-output.txt/,
  );
  const error = text(
    "bad\n".repeat(10) +
      "[Output truncated to 2000 lines / 50000 bytes. Full output: /tmp/error.txt]",
  );
  assert.match(renderMcpResult(error, options, theme, true).render(100).join("\n"), /^Error/);
  assert.match(
    renderMcpResult(error, options, theme, true).render(100).join("\n"),
    /\/tmp\/error.txt/,
  );
  assert.match(
    renderMcpResult(text(""), { ...options, isPartial: true }, theme)
      .render(100)
      .join("\n"),
    /Receiving/,
  );
  assert.match(renderMcpResult(text(""), options, theme).render(100).join("\n"), /No output/);
  const image = { content: [{ type: "image", data: "base64-secret", mimeType: "image/png" }] };
  const rendered = renderMcpResult(image, options, theme).render(100).join("\n");
  assert.match(rendered, /1 image/);
  assert.doesNotMatch(rendered, /base64-secret/);
  assert.equal(image.content[0]?.data, "base64-secret");
});

test("rendering handles resize, theme invalidation, Unicode, and terminal controls", () => {
  let color = "old";
  const dynamicTheme = {
    ...theme,
    fg: (_token: string, value: string) => `${color}:${value}`,
  } as Theme;
  const row = renderMcpResult(text("safe\x1b[2J\n" + "漢字".repeat(100)), options, dynamicTheme);
  assert.match(row.render(100).join("\n"), /old:/);
  color = "new";
  row.invalidate();
  assert.match(row.render(100).join("\n"), /new:/);
  for (const expanded of [false, true]) {
    const components = [
      row,
      renderMcpCall("srv", "tool", { code: "漢字".repeat(100) }, theme, expanded),
      renderMcpResult(text("漢字".repeat(100)), { ...options, expanded }, theme),
    ];
    for (const width of [1, 12, 40, 100])
      for (const component of components)
        for (const line of component.render(width)) {
          assert.ok(visibleWidth(line) <= width);
          assert.ok(!line.includes("\x1b[2J"));
        }
  }
});
