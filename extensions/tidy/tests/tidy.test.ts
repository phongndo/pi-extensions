import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  createEditToolDefinition,
  initTheme,
  type SessionEntry,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../config.ts";
import { builtinRenderers, ownsItsRow } from "../builtins.ts";
import { displayOptions, markUserPrompt, standApart } from "../index.ts";
import {
  createRenderers,
  EXPLORE,
  RowIndex,
  nestedCallLine,
  parseNestedArgs,
  type RenderContext,
  type ToolResult,
} from "../render.ts";
import {
  countMatches,
  displayName,
  displayPath,
  parseShellOutput,
  summarizeArgs,
} from "../text.ts";
import {
  cacheMissMessages,
  showsReasoningDrop,
  itemsOfMessage,
  segmentsOf,
  Timeline,
  type DisplayOptions,
} from "../timeline.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as unknown as Theme;

const text = (value: string, details?: unknown): ToolResult => ({
  content: [{ type: "text", text: value }],
  details,
});

interface Call {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isError?: boolean;
  durationMs?: number;
  inner?: ToolRenderers;
}

const assistant = (blocks: unknown[], timestamp = 1): SessionEntry =>
  ({ type: "message", message: { role: "assistant", content: blocks, timestamp } }) as SessionEntry;
const user = (value: string): SessionEntry =>
  ({ type: "message", message: { role: "user", content: value } }) as SessionEntry;
const toolCall = (id: string, name = "read") => ({ type: "toolCall", id, name, arguments: {} });

const OPTIONS: DisplayOptions = {
  showThinking: false,
  cacheMissNotices: false,
  cacheWarmingNotices: false,
};
const sourceOf = (entries: SessionEntry[], context: SessionEntry[] = entries) => ({
  context: () => context,
  all: () => entries,
  branch: () => entries,
  leafId: () => String(entries.length),
});
const timelineOver = (entries: SessionEntry[], options: DisplayOptions = OPTIONS) => {
  const timeline = new Timeline(
    () => options,
    (name) => EXPLORE.has(name),
  );
  timeline.reset(sourceOf(entries));
  return timeline;
};

/** A live row's render context, as Pi's tool rows build it. */
function rowContext(call: Call, expanded: boolean, state: object = {}): RenderContext {
  return {
    args: call.args,
    toolCallId: call.id,
    invalidate: () => {},
    lastComponent: undefined,
    state,
    cwd: "/work/repo",
    executionStarted: false,
    argsComplete: true,
    isPartial: !call.result,
    expanded,
    showImages: true,
    isError: call.isError ?? false,
    durationMs: call.durationMs,
    outputPad: 1,
    keyText: () => "ctrl+o",
    keyHint: (_key: string, description: string) => description,
  } as unknown as RenderContext;
}
const say = (value: string) => ({ type: "text", text: value });

/**
 * Draw a transcript's tool rows as plain text. `entries` decide which calls sit together; by
 * default every call is in one response.
 */
function draw(
  calls: Call[],
  options: { entries?: SessionEntry[]; expanded?: boolean; width?: number } = {},
): string[][] {
  const { expanded = false, width = 70 } = options;
  const entries = options.entries ?? [assistant(calls.map((call) => toolCall(call.id, call.tool)))];
  const index = new RowIndex();
  const timeline = timelineOver(entries);
  const views = calls.map((call) => {
    const renderers = createRenderers(call.tool, call.inner, index, timeline);
    const context = rowContext(call, expanded);
    const view = renderers.renderCall!(call.args, theme, context);
    if (call.result) {
      const slot = renderers.renderResult!(
        call.result,
        { expanded, isPartial: false },
        theme,
        context,
      );
      // Live rows draw everything from the call slot.
      assert.deepEqual(slot.render(width), []);
    }
    return view;
  });
  return views.map((view) => view.render(width).map((line) => stripAnsi(line).trimEnd()));
}

const MORE = "(click or ctrl+o)";

test("a command shows its first and last output lines", () => {
  const output = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
  const [row] = draw([
    { id: "a", tool: "bash", args: { command: "seq 20" }, result: text(output), durationMs: 1200 },
  ]);
  assert.deepEqual(row, [
    " • Ran seq 20 · 1.2s",
    "   └ line 1",
    "     line 2",
    `     … +16 lines ${MORE}`,
    "     line 19",
    "     line 20",
  ]);
});

test("a failed command names its exit code and keeps the error at the end", () => {
  const output = "a\nb\nc\nd\ne\nAssertionError: 2 !== 5\n\nCommand exited with code 1";
  const [row] = draw([
    {
      id: "a",
      tool: "bash",
      args: { command: "node test.js" },
      result: text(output),
      isError: true,
    },
  ]);
  assert.deepEqual(row, [
    " • Ran node test.js · exit 1",
    "   └ a",
    "     b",
    `     … +2 lines ${MORE}`,
    "     e",
    "     AssertionError: 2 !== 5",
  ]);
});

test("a successful command that prints a status line is not a failure", () => {
  const [row] = draw([
    { id: "a", tool: "bash", args: { command: "echo" }, result: text("Command aborted") },
  ]);
  assert.deepEqual(row, [" • Ran echo", "   └ Command aborted"]);
});

test("running and multi-line commands", () => {
  const [row] = draw([
    {
      id: "a",
      tool: "bash",
      args: { command: "python3 - <<'PY'\nprint(1)\nPY" },
      result: text(""),
    },
    { id: "b", tool: "bash", args: { command: "sleep 9" } },
  ]);
  assert.deepEqual(row, [" • Ran python3 - <<'PY' · +2 lines", "   └ (no output)"]);
  const [, running] = draw([
    { id: "a", tool: "bash", args: { command: "ls" }, result: text("x") },
    { id: "b", tool: "bash", args: { command: "sleep 9" } },
  ]);
  assert.deepEqual(running, [" • Running sleep 9"]);
});

test("reads and searches in a row share one Explored block", () => {
  const rows = draw([
    { id: "a", tool: "read", args: { path: "/work/repo/test.js" }, result: text("x") },
    { id: "b", tool: "read", args: { path: "math.js", offset: 1, limit: 3 }, result: text("y") },
    {
      id: "c",
      tool: "grep",
      args: { pattern: "add", path: "src" },
      result: text("a:1:x", { totalMatched: 4 }),
    },
    { id: "d", tool: "bash", args: { command: "ls" }, result: text("x") },
    { id: "e", tool: "ls", args: { path: "/work/repo" }, result: text("a\nb") },
  ]);
  assert.deepEqual(rows, [
    [" • Explored", "   └ Read test.js, math.js:1-3", '     Search "add" in src · 4 matches'],
    [],
    [],
    [" • Ran ls", "   └ x"],
    [" • Explored", "   └ List ."],
  ]);
});

test("text between reads starts a new block", () => {
  const rows = draw(
    [
      { id: "a", tool: "read", args: { path: "a.ts" }, result: text("x") },
      { id: "b", tool: "read", args: { path: "b.ts" }, result: text("y") },
    ],
    { entries: [assistant([toolCall("a")], 1), assistant([say("Now b."), toolCall("b")], 2)] },
  );
  assert.deepEqual(rows, [
    [" • Explored", "   └ Read a.ts"],
    [" • Explored", "   └ Read b.ts"],
  ]);
});

test("an edit counts its changes and previews the diff", () => {
  const diff = Array.from({ length: 12 }, (_, i) => `+${i + 1} new`).join("\n");
  const [row] = draw([
    { id: "a", tool: "edit", args: { path: "a.ts" }, result: text("ok", { diff, patch: "" }) },
  ]);
  assert.equal(row![0], " • Edited a.ts (+12 -0)");
  assert.equal(row!.length, 9);
  assert.equal(row!.at(-1), `     … +5 lines ${MORE}`);
  const [written] = draw([
    { id: "a", tool: "write", args: { path: "b.ts", content: "1\n2\n" }, result: text("ok") },
  ]);
  assert.deepEqual(written, [" • Wrote b.ts (2 lines)"]);
});

test("a script lists the calls it made", () => {
  const calls = [
    { name: "read", args: '{"path":"/work/repo/a.ts"}' },
    { name: "bash", args: '{"command":"node test.js"}', status: "error" },
  ];
  const [row] = draw([
    {
      id: "a",
      tool: "codemode",
      args: { code: "const r = 1;\ntext(r)" },
      result: text("", { calls }),
    },
  ]);
  assert.deepEqual(row, [
    " • Ran script · 2 calls · 1 failed",
    "   └ Read a.ts",
    "     Ran node test.js",
  ]);
  // Pi cuts long recorded arguments short; the leading fields still read.
  const cut = String.raw`{"command":"printf 'a\n'; dirname \"$PI_SESS`;
  assert.deepEqual(parseNestedArgs(cut), { command: "printf 'a\n'; dirname \"$PI_SESS" });
  assert.equal(
    nestedCallLine({ name: "grep", args: '{"pattern":"x|y","path":"src"}' }, "/"),
    'Searched "x|y" in src',
  );
});

test("other tools: name and arguments, their own result capped", () => {
  const long: ToolRenderers = {
    renderResult: () =>
      new Text(Array.from({ length: 9 }, (_, i) => `advice ${i}`).join("\n"), 0, 0),
  };
  const [advisor] = draw([{ id: "a", tool: "advisor", args: {}, result: text("x"), inner: long }]);
  assert.deepEqual(advisor, [
    " • Asked advisor",
    "   └ advice 0",
    "     advice 1",
    "     advice 2",
    "     advice 3",
    `     … +5 lines ${MORE}`,
  ]);
  const [mcp] = draw([
    { id: "a", tool: "mcp__github__search", args: { query: "pi tidy" }, result: text("r") },
  ]);
  assert.deepEqual(mcp, [" • Called github · search(pi tidy)", "   └ r"]);
  const titled: ToolRenderers = { renderCall: () => new Text("x", 0, 0) };
  const [own] = draw([
    { id: "a", tool: "vault", args: { token: "hunter2" }, result: text(""), inner: titled },
  ]);
  assert.deepEqual(own, [" • Called vault"]);
});

test("expanding shows everything, including a long command and Pi's status line", () => {
  const command = `echo ${"x".repeat(80)} END-TOKEN`;
  const output =
    "boom\n\n[Showing lines 1-1 of 1. Full output: /tmp/out]\n\nCommand timed out after 5 seconds";
  const [row] = draw(
    [{ id: "a", tool: "bash", args: { command }, result: text(output), isError: true }],
    {
      expanded: true,
      width: 40,
    },
  );
  const joined = row!.join("\n");
  assert.ok(joined.includes("END-TOKEN"));
  assert.ok(joined.includes("/tmp/out"));
  assert.ok(joined.includes("Command timed out after 5 seconds"));
  const [explored] = draw(
    [{ id: "a", tool: "read", args: { path: "a.txt" }, result: text("one\ntwo") }],
    { expanded: true },
  );
  assert.deepEqual(explored, [" • Explored", "   └ Read a.txt", "       one", "       two"]);
});

test("escape sequences in output and arguments are dropped", () => {
  const [row] = draw([
    {
      id: "a",
      tool: "bash",
      args: { command: "printf x\x1b]0;title\x07" },
      result: text("\x1b[31mred\x1b[0m"),
    },
  ]);
  assert.ok(row!.every((line) => !line.includes("\x1b") && !line.includes("\x07")));
  assert.deepEqual(row, [" • Ran printf x", "   └ red"]);
});

test("blocks never draw past the terminal width, even with wide glyphs", () => {
  const command = "echo 漢字漢字漢字漢字漢字漢字 && ls\nsecond";
  const output = "漢字漢字漢字漢字漢字漢字漢字漢字\n".repeat(8);
  for (const expanded of [false, true]) {
    for (let width = 1; width <= 40; width++) {
      const rows = draw(
        [
          { id: "a", tool: "bash", args: { command }, result: text(output) },
          {
            id: "b",
            tool: "read",
            args: { path: "漢字漢字漢字漢字漢字漢字.ts" },
            result: text(output),
          },
          {
            id: "c",
            tool: "edit",
            args: { path: "x.ts" },
            result: text("ok", { diff: `+1 ${output}` }),
          },
          {
            id: "d",
            tool: "bash",
            args: { command },
            result: text(`${output}\nCommand exited with code 2`),
            isError: true,
          },
        ],
        { expanded, width },
      );
      for (const line of rows.flat()) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
  }
});

const click = (x: number, y: number) =>
  ({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x + 10,
    screenY: y + 20,
    width: 40,
    height: 3,
  }) as unknown as TuiMouseEvent;

test("clicks in an expanded block reach another tool's own component, as its target", () => {
  const seen: Array<{ x: number; y: number }> = [];
  const widget: Component = {
    render: () => ["clickable"],
    invalidate: () => {},
    handleMouse: (event) => {
      seen.push({ x: event.x, y: event.y });
      return { capture: true };
    },
  };
  const call: Call = { id: "a", tool: "widget", args: {}, result: text("x") };
  const renderers = createRenderers(
    "widget",
    { renderResult: () => widget },
    new RowIndex(),
    timelineOver([]),
  );
  const context = rowContext(call, true);
  const view = renderers.renderCall!({}, theme, context);
  renderers.renderResult!(call.result!, { expanded: true, isPartial: false }, theme, context);
  assert.deepEqual(
    view.render(40).map((line) => stripAnsi(line)),
    [" • Called widget()", "   └ clickable"],
  );
  const result = view.handleMouse!(click(7, 1)) as {
    handled: boolean;
    capture: boolean;
    target: { component: Component; originX: number; originY: number };
  };
  assert.equal(result.target.component, widget);
  assert.deepEqual(
    [result.handled, result.capture, result.target.originX, result.target.originY],
    [true, true, 15, 21],
  );
  assert.deepEqual(seen, [{ x: 2, y: 0 }]);
  assert.equal(view.handleMouse!(click(7, 0)), undefined);
});

test("another renderer's component is redrawn only when its lines change", () => {
  let lines = ["one"];
  let clicks = 0;
  const widget: Component = {
    render: () => lines,
    invalidate: () => {},
    handleMouse: () => {
      clicks++;
      return { capture: true };
    },
  };
  const call: Call = { id: "a", tool: "widget", args: {}, result: text("x") };
  const renderers = createRenderers(
    "widget",
    { renderResult: () => widget },
    new RowIndex(),
    timelineOver([]),
  );
  const context = rowContext(call, true);
  const view = renderers.renderCall!({}, theme, context);
  renderers.renderResult!(call.result!, { expanded: true, isPartial: false }, theme, context);
  const first = view.render(40);
  // Same lines from the widget: the row keeps its lines, and clicks still reach the widget.
  assert.equal(view.render(40), first);
  assert.ok(view.handleMouse!(click(7, 1)));
  assert.equal(clicks, 1);
  lines = ["two"];
  assert.deepEqual(
    view.render(40).map((line) => stripAnsi(line)),
    [" • Called widget()", "   └ two"],
  );
});

test("a run whose first read is still running expands on click", () => {
  const entries = [assistant([toolCall("a"), toolCall("b")])];
  const index = new RowIndex();
  const timeline = timelineOver(entries);
  const first: Call = { id: "a", tool: "read", args: { path: "a.ts" } };
  const second: Call = { id: "b", tool: "read", args: { path: "b.ts" }, result: text("one\ntwo") };
  const leader = createRenderers("read", undefined, index, timeline).renderCall!(
    first.args,
    theme,
    rowContext(first, false),
  );
  const renderers = createRenderers("read", undefined, index, timeline);
  const context = rowContext(second, false);
  renderers.renderCall!(second.args, theme, context);
  renderers.renderResult!(second.result!, { expanded: false, isPartial: false }, theme, context);
  assert.deepEqual(leader.render(60).map(stripAnsi), [
    " • Exploring",
    "   └ Read a.ts",
    "     Read b.ts",
  ]);
  assert.deepEqual(leader.handleMouse!(click(3, 0)), { handled: true });
  assert.deepEqual(leader.render(60).map(stripAnsi).slice(-2), ["       one", "       two"]);
});

test("timeline items follow Pi's display order", () => {
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hm" }, toolCall("a"), say("ok"), toolCall("b")],
  };
  // Pi draws a response's text above all of its tool calls.
  assert.deepEqual(itemsOfMessage(message, OPTIONS), [
    { kind: "break" },
    { kind: "tool", id: "a", name: "read" },
    { kind: "tool", id: "b", name: "read" },
  ]);
  const quiet = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hm" }, toolCall("a")],
  };
  assert.deepEqual(itemsOfMessage(quiet, OPTIONS), [{ kind: "tool", id: "a", name: "read" }]);
  assert.equal(itemsOfMessage(quiet, { showThinking: true })[0]!.kind, "break");
  assert.equal(itemsOfMessage({ ...quiet, stopReason: "length" }, OPTIONS)[0]!.kind, "break");
  assert.equal(itemsOfMessage(quiet, OPTIONS, true).at(-1)!.kind, "break");
  assert.deepEqual(itemsOfMessage({ role: "toolResult" }, OPTIONS), []);
  assert.deepEqual(itemsOfMessage({ role: "custom", display: false }, OPTIONS), []);
  const segments = segmentsOf(
    [
      { kind: "tool", id: "a", name: "read" },
      { kind: "tool", id: "b", name: "grep" },
      { kind: "tool", id: "c", name: "bash" },
      { kind: "tool", id: "d", name: "ls" },
      { kind: "break" },
      { kind: "tool", id: "e", name: "read" },
    ],
    (name) => EXPLORE.has(name),
  );
  assert.deepEqual(segments.get("b"), ["a", "b"]);
  assert.deepEqual(segments.get("d"), ["d"]);
  assert.deepEqual(segments.get("e"), ["e"]);
  assert.equal(segments.get("c"), undefined);
});

test("a read before a response's text stays in its own block", () => {
  const rows = draw(
    [
      { id: "a", tool: "read", args: { path: "a.ts" }, result: text("x") },
      { id: "b", tool: "read", args: { path: "b.ts" }, result: text("y") },
    ],
    { entries: [assistant([toolCall("a")], 1), assistant([toolCall("b"), say("Then b.")], 2)] },
  );
  assert.deepEqual(rows, [
    [" • Explored", "   └ Read a.ts"],
    [" • Explored", "   └ Read b.ts"],
  ]);
});

test("after compaction a kept read draws even if an earlier read's row remains", () => {
  const rows = draw(
    [
      { id: "a", tool: "read", args: { path: "a.ts" }, result: text("x") },
      { id: "b", tool: "read", args: { path: "b.ts" }, result: text("y") },
    ],
    { entries: [{ type: "compaction" } as SessionEntry, assistant([toolCall("b")], 2)] },
  );
  assert.deepEqual(rows[1], [" • Explored", "   └ Read b.ts"]);
});

test("cache-miss notices end a run, as Pi prints them", () => {
  const usage = (input: number, cacheRead: number) => ({
    input,
    cacheRead,
    cacheWrite: 0,
    cost: {},
  });
  const response = (cacheRead: number, timestamp: number) =>
    ({
      type: "message",
      message: {
        role: "assistant",
        content: [toolCall(`t${timestamp}`)],
        usage: usage(50_000 - cacheRead, cacheRead),
        timestamp,
      },
    }) as SessionEntry;
  const entries = [response(0, 1), response(49_000, 2), response(0, 3)];
  const misses = cacheMissMessages(entries);
  assert.equal(misses.size, 1);
  assert.ok(misses.has((entries[2] as { message: unknown }).message));
  const timeline = new Timeline(
    () => ({ ...OPTIONS, cacheMissNotices: true }),
    (name) => EXPLORE.has(name),
  );
  timeline.reset(sourceOf(entries));
  assert.deepEqual(timeline.segment("t1"), ["t1", "t2", "t3"]);
  timeline.reset(sourceOf([...entries, response(0, 4)]));
  assert.deepEqual(timeline.segment("t4"), ["t4"]);
});

test("a streaming response joins the run until the session saves it, and leaving the branch drops it", () => {
  const entries: SessionEntry[] = [user("go"), assistant([toolCall("a")], 1)];
  const timeline = timelineOver(entries);
  const live = { role: "assistant", content: [toolCall("b")], timestamp: 2 };
  timeline.setLive(live);
  assert.deepEqual(timeline.segment("b"), ["a", "b"]);
  entries.push({ type: "message", message: live } as SessionEntry);
  timeline.changed();
  assert.deepEqual(timeline.segment("b"), ["a", "b"]);
  timeline.setLive({ role: "assistant", content: [toolCall("c")], timestamp: 3 });
  assert.deepEqual(timeline.segment("c"), ["a", "b", "c"]);
  timeline.clearLive();
  assert.equal(timeline.segment("c"), undefined);
});

test("an export draws each row alone and leaves the live row untouched", () => {
  const call: Call = {
    id: "a",
    tool: "bash",
    args: { command: "seq 3" },
    result: text("1\n2\n3"),
    durationMs: 2000,
  };
  const index = new RowIndex();
  const timeline = timelineOver([assistant([toolCall("a", "bash")])]);
  const live = createRenderers("bash", undefined, index, timeline);
  const liveContext = rowContext(call, false);
  const liveView = live.renderCall!(call.args, theme, liveContext);
  live.renderResult!(call.result!, { expanded: false, isPartial: false }, theme, liveContext);
  const before = liveView.render(60).map(stripAnsi);

  // Pi's HTML export: its own state, execution started, the call drawn before its result.
  const exported = createRenderers("bash", undefined, index, timeline);
  const state = {};
  const exportContext = (expanded: boolean, isPartial: boolean) =>
    ({
      ...rowContext(call, expanded, state),
      executionStarted: true,
      isPartial,
      durationMs: undefined,
    }) as RenderContext;
  const header = exported.renderCall!(call.args, theme, exportContext(false, true))
    .render(60)
    .map(stripAnsi);
  const collapsed = exported.renderResult!(
    call.result!,
    { expanded: false, isPartial: false },
    theme,
    exportContext(false, false),
  );
  assert.deepEqual(collapsed.render(60).map(stripAnsi), ["   └ 1", "     2", "     3"]);
  exported.renderResult!(
    call.result!,
    { expanded: true, isPartial: false },
    theme,
    exportContext(true, false),
  );
  assert.deepEqual(header, [" • Ran seq 3"]);
  assert.deepEqual(liveView.render(60).map(stripAnsi), before);
  assert.equal(before[0], " • Ran seq 3 · 2.0s");
});

test("another tool's renderers share their state between call and result", () => {
  const inner: ToolRenderers = {
    renderCall: (_args, _theme, context) => {
      (context.state as { label?: string }).label = "from call";
      return new Text("x", 0, 0);
    },
    renderResult: (_result, _options, _theme, context) =>
      new Text((context.state as { label?: string }).label ?? "none", 0, 0),
  };
  const [row] = draw([{ id: "a", tool: "widget", args: {}, result: text("x"), inner }]);
  assert.deepEqual(row, [" • Called widget", "   └ from call"]);
});

test("renderers that draw their own shell keep their row", () => {
  assert.equal(ownsItsRow({ renderShell: "self", renderCall: () => new Text("", 0, 0) }), true);
  assert.equal(ownsItsRow({ renderCall: () => new Text("", 0, 0) }), false);
  assert.equal(ownsItsRow(undefined), false);
});

test("C1 controls are dropped and a line break in a path stays on one line", () => {
  const [row] = draw(
    [{ id: "a", tool: "read", args: { path: "a\nb\u009b2J.ts" }, result: text("x\u0085y") }],
    {
      expanded: true,
    },
  );
  assert.deepEqual(row, [" • Explored", "   └ Read a\\nb.ts", "       xy"]);
});

test("other tools' wide output and the line count fit narrow panes", () => {
  const wide: ToolRenderers = {
    renderResult: () => ({
      render: () => Array.from({ length: 6 }, () => "x".repeat(60)),
      invalidate: () => {},
    }),
  };
  for (const expanded of [false, true])
    for (let width = 1; width <= 30; width++) {
      const [row] = draw([{ id: "a", tool: "widget", args: {}, result: text(""), inner: wide }], {
        expanded,
        width,
      });
      for (const line of row!) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
      if (!expanded && width >= 20) assert.equal(row!.length, 6);
    }
});

test("search counts and timeouts", () => {
  const grep = "a.ts-1- before\na.ts:2: hit\na.ts-3- after\n\n[100 matches limit reached]";
  assert.equal(countMatches(grep), 1);
  assert.equal(countMatches("custom format\nsecond"), 2);
  assert.equal(
    parseShellOutput("x\n\nCommand timed out after 0.5 seconds", true).failure,
    "timed out after 0.5s",
  );
});

test("shell output parsing", () => {
  assert.deepEqual(parseShellOutput("a\nb\n\nCommand exited with code 2", true), {
    lines: ["a", "b"],
    failure: "exit 2",
    status: "Command exited with code 2",
  });
  assert.deepEqual(parseShellOutput("(no output)", false), { lines: [] });
});

test("paths and MCP names read short", () => {
  assert.equal(displayPath("/work/repo/a/b.ts", "/work/repo"), "a/b.ts");
  assert.equal(displayPath("/elsewhere/x", "/work/repo"), "/elsewhere/x");
  assert.equal(displayName("mcp__exa__web_search"), "exa · web_search");
});

test("user prompts get a marker unless they open with block Markdown", () => {
  assert.equal(markUserPrompt("fix the bug"), "› fix the bug");
  assert.equal(markUserPrompt("# Plan\n- a"), "# Plan\n- a");
  assert.equal(markUserPrompt("- item"), "- item");
  assert.equal(markUserPrompt("```ts\nx\n```"), "```ts\nx\n```");
});

test("config keeps known keys and defaults the rest", async () => {
  assert.deepEqual(normalizeConfig({ enabled: false }), { enabled: false });
  assert.deepEqual(normalizeConfig({ enabled: "no" }), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ tools: false, style: "claude" }), { enabled: false });
  const dir = await mkdtemp(join(tmpdir(), "tidy-"));
  try {
    assert.deepEqual(await loadConfig(join(dir, "missing.json")), DEFAULT_CONFIG);
    await writeFile(join(dir, "bad.json"), "{");
    assert.deepEqual(await loadConfig(join(dir, "bad.json")), DEFAULT_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const entry = (id: string, parentId: string | null, rest: object) =>
  ({ id, parentId, ...rest }) as unknown as SessionEntry;

test("a compaction drawn live breaks runs where it happened, until Pi redraws from the start", async () => {
  const kept = entry("k", null, {
    type: "message",
    message: { role: "assistant", content: [toolCall("a")], timestamp: 1 },
  });
  const compaction = entry("c", "k", { type: "compaction" });
  const after = entry("n", "c", {
    type: "message",
    message: { role: "assistant", content: [toolCall("b")], timestamp: 2 },
  });
  const branch = [kept, compaction, after];
  const context = [compaction, kept, after]; // buildContextEntries() puts the compaction first
  const timeline = new Timeline(
    () => OPTIONS,
    (name) => EXPLORE.has(name),
  );
  timeline.reset(sourceOf([kept], [kept]));
  assert.deepEqual(timeline.segment("a"), ["a"]);
  // The session compacts and Pi redraws with the summary after the kept read.
  const source = {
    context: () => context,
    all: () => branch,
    branch: () => branch,
    leafId: () => "n",
  };
  (timeline as unknown as { source: unknown }).source = source;
  timeline.noteRedraw();
  assert.deepEqual(timeline.segment("b"), ["b"]);
  assert.deepEqual(timeline.segment("a"), ["a"]);
  // A later full redraw (say /tree) draws the summary first: a and b then sit together.
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  timeline.noteRedraw();
  assert.deepEqual(timeline.segment("b"), ["a", "b"]);
});

test("a new entry is picked up from the session leaf, without an event", () => {
  const entries: SessionEntry[] = [assistant([toolCall("a")], 1)];
  const timeline = timelineOver(entries);
  assert.deepEqual(timeline.segment("a"), ["a"]);
  entries.push(assistant([toolCall("b")], 2));
  assert.deepEqual(timeline.segment("a"), ["a", "b"]);
});

test("reasoning-drop notices end a run, as Pi prints them live", () => {
  const dropped = (count: number) => [
    {
      type: "anthropic_input_transformations",
      details: {
        transformations: Array.from({ length: count }, () => ({ type: "thinking_dropped" })),
      },
    },
  ];
  const first = {
    role: "assistant",
    content: [toolCall("a")],
    timestamp: 1,
    diagnostics: dropped(1),
  };
  assert.equal(showsReasoningDrop(first, []), true);
  const prior = [{ type: "message", message: first } as unknown as SessionEntry];
  assert.equal(showsReasoningDrop({ ...first, timestamp: 2 }, prior), false);
  assert.equal(
    showsReasoningDrop({ ...first, timestamp: 2, diagnostics: dropped(2) }, prior),
    true,
  );

  const entries: SessionEntry[] = [];
  const timeline = timelineOver(entries, { ...OPTIONS, reasoningDropNotices: true });
  timeline.noteResponseEnd(first);
  entries.push(
    { type: "message", message: first } as unknown as SessionEntry,
    assistant([toolCall("b")], 2),
  );
  assert.deepEqual(timeline.segment("b"), ["b"]);
});

test("notice settings from Pi 1.5 and 1.6", () => {
  assert.deepEqual(
    [
      displayOptions({ showCacheMissNotices: true }).cacheMissNotices,
      displayOptions({ showCacheMissNotices: true }).reasoningDropNotices,
    ],
    [true, true],
  );
  const modern = displayOptions({
    notices: { cacheMisses: true, reasoningDrops: false },
    showCacheMissNotices: true,
  });
  assert.deepEqual(
    [modern.cacheMissNotices, modern.cacheWarmingNotices, modern.reasoningDropNotices],
    [true, true, false],
  );
  assert.equal(displayOptions({}).cacheMissNotices, false);
  assert.equal(displayOptions({ hideThinkingBlock: true }).showThinking, false);
});

test("self-shell renderers keep their row; Pi's own edit renderers do not", () => {
  const edit = createEditToolDefinition(process.cwd()) as unknown as ToolRenderers;
  assert.equal(
    ownsItsRow({
      renderShell: "self",
      renderCall: edit.renderCall,
      renderResult: edit.renderResult,
    }),
    false,
  );
  assert.equal(ownsItsRow({ renderShell: "self", renderResult: () => new Text("", 0, 0) }), true);
  assert.equal(
    ownsItsRow({
      renderShell: "self",
      renderCall: edit.renderCall,
      renderResult: () => new Text("", 0, 0),
    }),
    true,
  );
});

test("a run skips tools whose rows another renderer draws", () => {
  const segments = segmentsOf(
    [
      { kind: "tool", id: "a", name: "read" },
      { kind: "tool", id: "g", name: "grep" },
      { kind: "tool", id: "b", name: "read" },
    ],
    (name) => name === "read",
  );
  assert.deepEqual(segments.get("b"), ["b"]);
});

test("after a click on a running run, the next click collapses it even once the leader finishes", () => {
  const index = new RowIndex();
  const timeline = timelineOver([assistant([toolCall("a"), toolCall("b")])]);
  const first: Call = { id: "a", tool: "read", args: { path: "a.ts" } };
  const second: Call = { id: "b", tool: "read", args: { path: "b.ts" }, result: text("one") };
  const leaderRenderers = createRenderers("read", undefined, index, timeline);
  const leaderContext = rowContext(first, false);
  const leader = leaderRenderers.renderCall!(first.args, theme, leaderContext);
  const other = createRenderers("read", undefined, index, timeline);
  const context = rowContext(second, false);
  other.renderCall!(second.args, theme, context);
  other.renderResult!(second.result!, { expanded: false, isPartial: false }, theme, context);
  leader.render(60);
  leader.handleMouse!(click(3, 0));
  assert.equal(leader.render(60).length, 4);
  // The leader finishes; Pi's own state is still collapsed, so the next click is Tidy's.
  const done = { ...leaderContext, isPartial: false } as RenderContext;
  leaderRenderers.renderResult!(text("x"), { expanded: false, isPartial: false }, theme, done);
  assert.equal(leader.render(60).length, 5);
  assert.deepEqual(leader.handleMouse!(click(3, 0)), { handled: true });
  assert.equal(leader.render(60).length, 2);
  // Back in step with Pi: Pi takes clicks again.
  assert.equal(leader.handleMouse!(click(3, 0)), undefined);
});

test("an exported failure shows a neutral header and says how it failed", () => {
  const call: Call = {
    id: "a",
    tool: "bash",
    args: { command: "false" },
    result: text("\n\nCommand exited with code 1"),
    isError: true,
  };
  const exported = createRenderers("bash", undefined, new RowIndex(), timelineOver([]));
  const state = {};
  const context = (isPartial: boolean) =>
    ({
      ...rowContext(call, false, state),
      executionStarted: true,
      isPartial,
      isError: !isPartial,
    }) as RenderContext;
  const colors: string[] = [];
  const spy = {
    ...theme,
    fg: (color: string, value: string) => (colors.push(color), value),
  } as unknown as Theme;
  const header = exported.renderCall!(call.args, spy, context(true)).render(60);
  assert.ok(colors.includes("dim") && !colors.includes("success"));
  const body = exported.renderResult!(
    call.result!,
    { expanded: false, isPartial: false },
    theme,
    context(false),
  );
  assert.deepEqual(header.map(stripAnsi), [" • Ran false"]);
  assert.deepEqual(body.render(60).map(stripAnsi), ["   └ (no output)", "     exit 1"]);
});

test("grep lines are read by the path they share", () => {
  // A path holding a context marker.
  const odd =
    "draft-12- final.md-2- before\ndraft-12- final.md:3: hit\ndraft-12- final.md-4- after";
  assert.equal(countMatches(odd), 1);
  // Text holding a context marker.
  const text = "src/a.ts-11- x\nsrc/a.ts:12: foo-3- bar\nsrc/a.ts-13- y";
  assert.equal(countMatches(text), 1);
  assert.equal(countMatches("x:y.ts-12- field:42: value\nx:y.ts:13: hit"), 1);
});

test("a glob with a line break stays on one line", () => {
  const [row] = draw([
    {
      id: "a",
      tool: "grep",
      args: { pattern: "x", glob: "*.ts\n*.js" },
      result: text("No matches found"),
    },
  ]);
  assert.deepEqual(row, [" • Explored", '   └ Search "x" (*.ts\\n*.js) · no matches']);
});

test("extension entries end a run: Pi may draw them as cards", () => {
  const card = { type: "custom", customType: "status-card", data: {} } as unknown as SessionEntry;
  const timeline = timelineOver([
    assistant([toolCall("a")], 1),
    card,
    assistant([toolCall("b")], 2),
  ]);
  assert.deepEqual(timeline.segment("b"), ["b"]);
});

test("rows Pi dropped when it drew the transcript again are forgotten", async () => {
  const index = new RowIndex();
  const row = (id: string) => ({ id }) as unknown as Parameters<RowIndex["register"]>[0];
  index.register(row("a"));
  index.register(row("b"));
  await Promise.resolve();
  // Pi redraws after compaction and keeps only b.
  assert.equal(index.register(row("b")), true);
  await Promise.resolve();
  assert.deepEqual([index.has("a"), index.has("b")], [false, true]);
});

test("calls drawn by another renderer, or apart for images, end a run", () => {
  const index = new RowIndex();
  const entries = [assistant([toolCall("a"), toolCall("g", "grep"), toolCall("b")])];
  const timeline = new Timeline(
    () => OPTIONS,
    (name, id) => EXPLORE.has(name) && !index.isApart(id),
  );
  index.onApartChange = () => timeline.changed();
  timeline.reset(sourceOf(entries));
  assert.deepEqual(timeline.segment("b"), ["a", "g", "b"]);
  index.setApart("g", true);
  assert.deepEqual(timeline.segment("b"), ["b"]);
});

test("another extension's result renderer for a built-in tool replaces Tidy's result", () => {
  const edit = builtinRenderers("edit")!;
  const inner: ToolRenderers = {
    renderCall: edit.renderCall,
    renderResult: () => new Text("custom diff view", 0, 0),
  };
  const result = text("ok", { diff: "+1 new", patch: "" });
  const [row] = draw([{ id: "a", tool: "edit", args: { path: "a.ts" }, result, inner }]);
  assert.deepEqual(row, [" • Edited a.ts (+1 -0)", "   └ custom diff view"]);
  const stock: ToolRenderers = { renderCall: edit.renderCall, renderResult: edit.renderResult };
  const [own] = draw([{ id: "a", tool: "edit", args: { path: "a.ts" }, result, inner: stock }]);
  assert.notEqual(own![1], "   └ custom diff view");
});

test("argument keys with line breaks stay on one line", () => {
  assert.equal(summarizeArgs({ "a\nb": 1, c: 2 }), "a\\nb: 1, c: 2");
});

test("grep without context lines counts every line as a match", () => {
  assert.equal(countMatches("draft-12- final.md:3: hit", false), 1);
  const [row] = draw([
    { id: "a", tool: "grep", args: { pattern: "hit" }, result: text("draft-12- final.md:3: hit") },
  ]);
  assert.deepEqual(row, [" • Explored", '   └ Search "hit" · 1 match']);
});

test("a response's notices use the settings at its end, not a stale copy", () => {
  let options: DisplayOptions = { ...OPTIONS };
  const entries: SessionEntry[] = [];
  const timeline = new Timeline(
    () => options,
    (name) => EXPLORE.has(name),
  );
  timeline.reset(sourceOf(entries));
  timeline.segment("x");
  options = { ...OPTIONS, reasoningDropNotices: true };
  const message = {
    role: "assistant",
    content: [toolCall("a")],
    timestamp: 1,
    diagnostics: [
      {
        type: "anthropic_input_transformations",
        details: { transformations: [{ type: "thinking_dropped" }] },
      },
    ],
  };
  timeline.noteResponseEnd(message);
  entries.push(
    { type: "message", message } as unknown as SessionEntry,
    assistant([toolCall("b")], 2),
  );
  assert.deepEqual(timeline.segment("b"), ["b"]);
});

test("a detached row redrawing later does not displace the current row", () => {
  const index = new RowIndex();
  const timeline = timelineOver([assistant([toolCall("a")])]);
  const call: Call = { id: "a", tool: "read", args: { path: "a.ts" }, result: text("x") };
  const old = createRenderers("read", undefined, index, timeline);
  const oldContext = rowContext(call, false);
  old.renderCall!(call.args, theme, oldContext);
  const current = createRenderers("read", undefined, index, timeline);
  const currentContext = rowContext(call, false);
  const view = current.renderCall!(call.args, theme, currentContext);
  // The old row's renderer runs again, as an async invalidate would.
  old.renderCall!(call.args, theme, oldContext);
  assert.deepEqual(view.render(60).map(stripAnsi), [" • Explored", "   └ Read a.ts"]);
});

test("a compaction that keeps no rows still forgets the rows it removed", () => {
  const index = new RowIndex();
  const entries: SessionEntry[] = [assistant([toolCall("a")], 1)];
  let context: SessionEntry[] = entries;
  const timeline = new Timeline(
    () => OPTIONS,
    (name) => EXPLORE.has(name),
  );
  timeline.onCompacted = (ids) => index.retain(ids);
  timeline.reset({
    context: () => context,
    all: () => entries,
    branch: () => entries,
    leafId: () => String(context.length),
  });
  createRenderers("read", undefined, index, timeline).renderCall!(
    {},
    theme,
    rowContext({ id: "a", tool: "read", args: {} }, false),
  );
  timeline.segment("a");
  assert.equal(index.has("a"), true);
  context = [entry("c", null, { type: "compaction" }), assistant([toolCall("b")], 2)];
  timeline.segment("b");
  assert.equal(index.has("a"), false);
});

test("an export does not mark live calls as drawn by another renderer", () => {
  const index = new RowIndex();
  const wrapped = standApart({ renderShell: "self", renderCall: () => new Text("x", 0, 0) }, index);
  const call: Call = { id: "g", tool: "grep", args: {} };
  wrapped.renderCall!({}, theme, {
    ...rowContext(call, false),
    executionStarted: true,
  } as RenderContext);
  assert.equal(index.isApart("g"), false);
  wrapped.renderCall!({}, theme, rowContext(call, false));
  assert.equal(index.isApart("g"), true);
});

test("thinking shown since the last frame splits runs on the next frame", async () => {
  let options: DisplayOptions = { ...OPTIONS };
  const thought = { type: "thinking", thinking: "hm" };
  const entries = [assistant([toolCall("a")], 1), assistant([thought, toolCall("b")], 2)];
  const timeline = new Timeline(
    () => options,
    (name) => EXPLORE.has(name),
  );
  timeline.reset(sourceOf(entries));
  assert.deepEqual(timeline.segment("b"), ["a", "b"]);
  options = { ...OPTIONS, showThinking: true };
  await Promise.resolve();
  assert.deepEqual(timeline.segment("b"), ["b"]);
});
