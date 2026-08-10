import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import questionExtension, { normalizeQuestions } from "../index.ts";
import { NumberedSelectList, QuestionDialog, type DialogAnswers } from "../ui.ts";

function createHarness() {
  const tools = new Map<string, any>();
  const pi = {
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  questionExtension(pi);
  return { tool: tools.get("question") };
}

function createContext(input: {
  mode?: ExtensionContext["mode"];
  hasUI?: boolean;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  text?: (
    title: string,
    placeholder?: string,
    options?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  notify?: (message: string) => void;
}): ExtensionContext {
  const mode = input.mode ?? "rpc";
  const text = input.text ?? (async () => "answer");
  return {
    mode,
    hasUI: input.hasUI ?? true,
    ui: {
      select: input.select ?? (async (_title, options) => options[0]),
      input: text,
      editor: text,
      notify: input.notify ?? (() => {}),
    },
  } as unknown as ExtensionContext;
}

test("registers a compact sequential question tool", () => {
  const { tool } = createHarness();
  assert.equal(tool.name, "question");
  assert.equal(tool.label, "question");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(tool.promptGuidelines, [
    "Use the question tool proactively whenever you need clarification about the user's intent, scope, preferences, constraints, or tradeoffs; prefer one brief question over guessing at a consequential assumption. Do not use question for information discoverable with available tools or for trivial, low-impact choices. Batch related questions in one call.",
  ]);
  assert.match(tool.description, /batch related questions/);
});

test("keeps the provider-visible tool contract cache-stable", () => {
  const { tool } = createHarness();
  const contract = {
    name: tool.name,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(contract)).digest("hex");
  assert.equal(fingerprint, "2bf4f78e8243becca421c3cca08df8f0ab3a28d826c06e27b23919552092aa86");
});

test("number keys immediately select the matching native list item", () => {
  const plain = (text: string) => text;
  const list = new NumberedSelectList(
    [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
    ],
    2,
    {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  );
  let selected: string | undefined;
  list.onSelect = (item) => {
    selected = item.value;
  };
  list.handleInput("2");
  assert.equal(selected, "second");
});

test("j/k and tab/shift-tab navigate the option list", () => {
  const plain = (text: string) => text;
  const list = new NumberedSelectList(
    [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
    ],
    2,
    {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  );

  list.handleInput("j");
  assert.equal(list.getSelectedItem()?.value, "second");
  list.handleInput("k");
  assert.equal(list.getSelectedItem()?.value, "first");
  list.handleInput("\t");
  assert.equal(list.getSelectedItem()?.value, "second");
  list.handleInput("\u001b[Z");
  assert.equal(list.getSelectedItem()?.value, "first");
});

test("matches Codex's layered option-and-notes flow", () => {
  let result: DialogAnswers | undefined;
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  const keybindings = {
    matches(data: string, binding: string) {
      return binding === "tui.select.cancel" && matchesKey(data, Key.escape);
    },
  };
  const theme = {
    fg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  };
  const dialog = new QuestionDialog(
    tui as any,
    keybindings as any,
    theme as any,
    [
      {
        id: "first",
        question: "Pick the first answer",
        options: [{ label: "Alpha" }, { label: "Beta" }],
        multiple: false,
      },
      {
        id: "second",
        question: "Pick the second answer",
        options: [{ label: "Gamma" }, { label: "Delta" }],
        multiple: false,
      },
    ],
    undefined,
    () => {},
    (answers) => {
      result = answers;
    },
  );
  dialog.focused = true;

  dialog.handleInput("l");
  assert.match(dialog.render(80).join("\n"), /Question 2\/2/);
  dialog.handleInput("h");
  assert.match(dialog.render(80).join("\n"), /Question 1\/2/);

  dialog.handleInput(" ");
  const selectedView = dialog.render(80).join("\n");
  assert.match(selectedView, /1\. Alpha  ✓/);
  assert.match(selectedView, /3\. None of the above/);
  assert.doesNotMatch(selectedView, /○|Continue/);

  dialog.handleInput("\t");
  assert.match(dialog.render(80).join("\n"), /Question 1\/2/);
  const note = "Something else that is long enough to wrap onto another line";
  for (const character of note) dialog.handleInput(character);
  const wrappedNotesView = dialog.render(30);
  assert.ok(wrappedNotesView.some((line) => line.includes("Something else")));
  assert.ok(wrappedNotesView.some((line) => line.includes("enough to wrap")));
  assert.ok(wrappedNotesView.every((line) => !/3\..*Something/.test(line)));
  dialog.handleInput("\r");
  assert.match(dialog.render(80).join("\n"), /Question 2\/2/);
  dialog.handleInput("1");

  assert.deepEqual(result, {
    first: ["Alpha", `user_note: ${note}`],
    second: ["Gamma"],
  });

  let noteOnlyResult: DialogAnswers | undefined;
  const noteOnlyDialog = new QuestionDialog(
    tui as any,
    keybindings as any,
    theme as any,
    [
      {
        id: "note_only",
        question: "Add context without choosing a preset",
        options: [{ label: "Preset one" }, { label: "Preset two" }],
        multiple: false,
      },
    ],
    undefined,
    () => {},
    (answers) => {
      noteOnlyResult = answers;
    },
  );
  noteOnlyDialog.focused = true;
  noteOnlyDialog.handleInput("j");
  noteOnlyDialog.handleInput("j");
  noteOnlyDialog.handleInput("\t");
  for (const character of "Only the note") noteOnlyDialog.handleInput(character);
  noteOnlyDialog.handleInput("\r");
  assert.deepEqual(noteOnlyResult, { note_only: ["user_note: Only the note"] });
});

test("returns only the selected labels keyed by question id", async () => {
  const { tool } = createHarness();
  const titles: string[] = [];
  const ctx = createContext({
    select: async (title, options) => {
      titles.push(title);
      return options[0];
    },
  });
  const result = await tool.execute(
    "call-1",
    {
      questions: [
        {
          id: "database",
          question: "Which database should I use?",
          options: [
            { label: "PostgreSQL", description: "Production workloads" },
            { label: "SQLite", description: "Simple local deployment" },
          ],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.content[0].text, '{"database":["PostgreSQL"]}');
  assert.equal(result.content[0].text.includes("Which database"), false);
  assert.deepEqual(result.details.answers, { database: ["PostgreSQL"] });
  assert.deepEqual(titles, ["Which database should I use?"]);
});

test("always offers a custom answer without requiring it in tool arguments", async () => {
  const { tool } = createHarness();
  const ctx = createContext({
    select: async (_title, options) => options.at(-1),
    text: async () => "Use the existing database",
  });
  const result = await tool.execute(
    "call-2",
    {
      questions: [
        {
          id: "database",
          question: "Which database should I use?",
          options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.content[0].text, '{"database":["Use the existing database"]}');
});

test("collects multiple choices in option order", async () => {
  const { tool } = createHarness();
  let calls = 0;
  const ctx = createContext({
    select: async (_title, options) => {
      calls++;
      if (calls === 1) return options[1];
      if (calls === 2) return options[0];
      return options.at(-1);
    },
  });
  const result = await tool.execute(
    "call-3",
    {
      questions: [
        {
          id: "checks",
          question: "Which checks should I run?",
          multiple: true,
          options: [{ label: "Unit tests" }, { label: "Integration tests" }, { label: "Lint" }],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.content[0].text, '{"checks":["Unit tests","Integration tests"]}');
});

test("returns a cancellation result without ending through an exception", async () => {
  const { tool } = createHarness();
  const result = await tool.execute(
    "call-4",
    {
      questions: [
        {
          id: "scope",
          question: "Which scope?",
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ],
    },
    undefined,
    undefined,
    createContext({ select: async () => undefined }),
  );

  assert.equal(result.content[0].text, '{"cancelled":true}');
  assert.equal(result.details.status, "cancelled");
});

test("does not hang when interactive UI is unavailable", async () => {
  const { tool } = createHarness();
  const result = await tool.execute(
    "call-5",
    { questions: [{ id: "scope", question: "Which scope?" }] },
    undefined,
    undefined,
    createContext({ mode: "print", hasUI: false }),
  );

  assert.equal(result.content[0].text, '{"unavailable":"interactive UI required"}');
  assert.equal(result.details.status, "unavailable");
});

test("allows up to six options while keeping the normal recommendation smaller", () => {
  const options = Array.from({ length: 6 }, (_, index) => ({ label: `Option ${index + 1}` }));
  assert.equal(
    normalizeQuestions([{ id: "scope", question: "Which?", options }])[0]?.options.length,
    6,
  );
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "scope", question: "Which?", options: [...options, { label: "Option 7" }] },
      ]),
    /two to six options/,
  );
});

test("rejects ambiguous answer maps before opening UI", () => {
  assert.throws(
    () =>
      normalizeQuestions([
        { id: "scope", question: "First?" },
        { id: "scope", question: "Second?" },
      ]),
    /ids must be unique/,
  );
  assert.throws(
    () => normalizeQuestions([{ id: "scope", question: "Which?", multiple: true }]),
    /cannot use multiple without options/,
  );
});

test("reserves the synthetic None of the above option label", () => {
  for (const label of ["None of the above", "nOnE oF tHe AbOvE"]) {
    assert.throws(
      () =>
        normalizeQuestions([
          {
            id: "scope",
            question: "Which?",
            options: [{ label }, { label: "A supplied option" }],
          },
        ]),
      /reserved option label: None of the above/,
    );
  }
});

test("cancels a pending RPC free-text prompt when the tool signal aborts", async () => {
  const { tool } = createHarness();
  const controller = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const ctx = createContext({
    text: async (_title, _placeholder, options) => {
      return new Promise<string | undefined>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
        resolveStarted();
      });
    },
  });

  const resultPromise = tool.execute(
    "call-abort",
    { questions: [{ id: "scope", question: "Which scope?" }] },
    controller.signal,
    undefined,
    ctx,
  );
  await started;
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.content[0].text, '{"cancelled":true}');
  assert.equal(result.details.status, "cancelled");
});
