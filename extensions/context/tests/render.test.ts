import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderRecallCall,
  renderRecallResult,
  renderNotesCall,
  renderNotesResult,
} from "../render.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const result = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const options = { expanded: false, isPartial: false };
const data = {
  results: Array.from({ length: 5 }, (_, i) => ({
    entryId: `entry-${i}`,
    role: "user",
    snippet: "Hello\nworld",
    timestamp: "2026-09-08",
  })),
  notes: [{ name: "plan", entryId: "note-1" }],
  nextCursor: "opaque-token",
  warning: "Historical evidence",
};

test("recall is compact by default and expands evidence, notes, and pagination", () => {
  const input = result(data);
  const before = JSON.stringify(input);
  const compact = renderRecallResult(input, options, theme).render(100).join("\n");
  assert.match(compact, /5 entries · 1 saved note · more available/);
  assert.match(compact, /Hello world/);
  assert.doesNotMatch(compact, /entry-4|opaque-token|Historical evidence/);
  const expanded = renderRecallResult(input, { ...options, expanded: true }, theme)
    .render(100)
    .join("\n");
  assert.match(expanded, /entry-4/);
  assert.match(expanded, /plan/);
  assert.match(expanded, /opaque-token/);
  assert.match(expanded, /Historical evidence/);
  assert.equal(JSON.stringify(input), before);
});

test("bounded reads show a preview and continuation offset", () => {
  const input = result({
    entryId: "abc",
    role: "note",
    text: "one\ntwo\nthree\nfour",
    totalChars: 100,
    nextOffset: 18,
  });
  const compact = renderRecallResult(input, options, theme).render(100).join("\n");
  assert.doesNotMatch(compact, /four/);
  assert.match(compact, /next offset 18/);
  assert.match(
    renderRecallResult(input, { ...options, expanded: true }, theme)
      .render(100)
      .join("\n"),
    /four/,
  );
});

test("headers tolerate partial args; all views fit narrow terminals and strip escapes", () => {
  const components = [
    renderRecallCall({}, theme),
    renderRecallCall(
      { query: "漢字".repeat(200) + "\x1b[2J\nspoof", limit: 5, cursor: "secret" },
      theme,
    ),
    renderNotesCall({}, theme),
    renderNotesCall({ action: "write", name: "plan", reset: true }, theme),
    renderRecallResult(result(data), options, theme),
    renderRecallResult(result(data), { ...options, expanded: true }, theme),
  ];
  for (const component of components) {
    for (const width of [1, 12, 40, 100]) {
      component.invalidate();
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width);
        assert.ok(!line.includes("\x1b[2J"));
      }
    }
  }
});

test("errors, pending, empty, and legacy results remain readable", () => {
  const legacy = { content: [{ type: "text", text: "Revision changed" }] };
  assert.match(
    renderRecallResult(legacy, options, theme, true).render(80).join("\n"),
    /Revision changed/,
  );
  assert.match(
    renderNotesResult(legacy, options, theme, true).render(80).join("\n"),
    /^Revision changed/,
  );
  assert.match(
    renderRecallResult(result({ results: [], notes: [] }), options, theme)
      .render(80)
      .join("\n"),
    /0 entries/,
  );
  assert.match(
    renderRecallResult(legacy, { ...options, isPartial: true }, theme)
      .render(80)
      .join("\n"),
    /Recalling/,
  );
  assert.match(
    renderNotesResult(legacy, { ...options, isPartial: true }, theme)
      .render(80)
      .join("\n"),
    /Saving/,
  );
});

test("notes shorten boilerplate without hiding reset caveats", () => {
  const text =
    "Checkpoint abc saved and verified. Context resets are off/unavailable; continue in the existing window.";
  assert.match(
    renderNotesResult({ content: [{ type: "text", text }] }, options, theme)
      .render(100)
      .join("\n"),
    /off\/unavailable/,
  );
  const note = {
    content: [
      { type: "text", text: "Note plan saved; revision abc. Read this entryId with recall." },
    ],
  };
  assert.equal(
    renderNotesResult(note, options, theme).render(100).join("\n").trim(),
    "✓ Note plan saved; revision abc.",
  );
});
