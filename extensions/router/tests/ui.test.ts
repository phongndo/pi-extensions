import { expect, test } from "bun:test";
import { type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { NativeAccount } from "../../../src/account-identity.ts";
import { RankingList, showRankings, promptAlias } from "../ui.ts";
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const account = (id: string, provider = "test"): NativeAccount => ({
  id,
  name: id,
  provider,
  credentialId: id,
  type: "oauth",
});
test("native ranking keys reorder within providers, cancel without mutation and bound widths", () => {
  const keys = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.models.reorderUp": { defaultKeys: "ctrl+up", description: "Rank up" },
      "app.models.reorderDown": { defaultKeys: "ctrl+down", description: "Rank down" },
    },
    {
      "app.models.reorderUp": "u",
      "app.models.reorderDown": "d",
      "tui.select.down": "j",
      "tui.select.confirm": "e",
      "tui.select.cancel": "q",
    },
  );
  const original = [account("a"), account("b"), account("c", "other"), account("d", "other")];
  let saved: NativeAccount[] | undefined;
  const view = new RankingList(
    original,
    new Map(),
    theme,
    keys,
    (result) => {
      saved = result;
    },
    () => 24,
  );
  view.handleInput("d"); // a moves below b
  view.handleInput("d"); // cannot cross provider boundary
  view.handleInput("e");
  expect(saved?.map((a) => a.id)).toEqual(["b", "a", "c", "d"]);
  expect(original.map((a) => a.id)).toEqual(["a", "b", "c", "d"]);
  const lines = view.render(120);
  expect(lines).toContain(" test");
  expect(lines).toContain(" other");
  expect(lines.filter((line) => line.startsWith("   1."))).toHaveLength(2);
  expect(lines.join("\n")).not.toContain("1. b");
  expect(lines.join("\n")).not.toContain("1. c");
  expect(lines.join("\n")).not.toContain("test · 1.");
  for (const width of [1, 20, 40, 80])
    expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  view.handleInput("q");
  expect(saved).toBeUndefined();
});
test("subscription rows contain only rank and optional alias; email reveal is temporary and selected-only", () => {
  const accounts: NativeAccount[] = [
    { ...account("one"), name: "Account 1", type: "oauth" },
    { ...account("two"), name: "Account 2", alias: "Work", type: "oauth" },
    { ...account("three"), name: "Account 3" },
  ];
  const emails = new Map([
    ["one", "personal@example.test"],
    ["two", "work@example.test"],
  ]);
  const create = () =>
    new RankingList(
      accounts,
      new Map(),
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      () => 24,
      undefined,
      undefined,
      emails,
    );
  const view = create();
  const text = () => view.render(120).join("\n");
  expect(view.render(120)).toContain(" > 1.");
  expect(view.render(120)).toContain("   2. Work");
  expect(view.render(120)).toContain("   3.");
  expect(text()).not.toContain("••••");
  for (const label of [
    "Account 1",
    "Account 2",
    "Account 3",
    "Subscription",
    "OAuth",
    "API",
    "personal@",
    "work@",
    "example.test",
  ])
    expect(text()).not.toContain(label);
  view.handleInput("e");
  expect(text()).toContain("personal@example.test");
  expect(text()).not.toContain("work@example.test");
  view.handleInput("e");
  expect(text()).not.toContain("personal@example.test");
  view.handleInput("e");
  view.handleInput("\u001b[B"); // Navigating automatically conceals the previous address.
  expect(text()).not.toContain("personal@example.test");
  view.handleInput("e");
  expect(text()).toContain("Work  work@example.test");
  for (const width of [1, 20, 40, 80])
    expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  view.handleInput("n");
  expect(text()).not.toContain("work@example.test");
  expect(create().render(120).join("\n")).not.toContain("example.test");
  expect(JSON.stringify(accounts)).not.toContain("example.test");
});
test("scrolled rankings retain provider headers and rename only the selected account", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const accounts = Array.from({ length: 24 }, (_, i) => ({
    ...account(`a${i}`, i < 12 ? "codex" : "xai"),
    alias: `Label ${i}`,
  }));
  let renamed = "";
  const view = new RankingList(
    accounts,
    new Map([
      ["xai", "xAI"],
      ["codex", "OpenAI Codex"],
    ]),
    theme,
    keys,
    () => {},
    () => 12,
    (_accounts, id) => {
      renamed = id;
    },
  );
  for (let i = 0; i < 24; i++) {
    const rows = view.render(120);
    expect(rows).toContain(i < 12 ? " OpenAI Codex" : " xAI");
    expect(rows.join("\n")).toContain(`> ${(i % 12) + 1}. Label ${i}`);
    expect(rows.length).toBeLessThanOrEqual(12);
    view.handleInput("n");
    expect(renamed).toBe(`a${i}`);
    view.handleInput("\u001b[B");
  }
});
test("ranking alias dialog preserves pending order and selection; cancel discards all edits", async () => {
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.models.reorderDown": { defaultKeys: "d", description: "Rank down" },
  });
  const original = [account("one"), account("two")];
  for (const save of [true, false]) {
    let prompts = 0;
    let active = false;
    const ctx = {
      mode: "tui",
      ui: {
        input: async () => {
          expect(active).toBe(false);
          return "Personal";
        },
        custom: async (factory: (...args: any[]) => any) => {
          let result: unknown;
          active = true;
          const view = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            theme,
            keys,
            (value: unknown) => {
              result = value;
              active = false;
            },
          );
          if (!prompts++) {
            view.handleInput("d");
            view.handleInput("n");
          } else {
            expect(view.render(120).join("\n")).toContain("> 2. Personal");
            view.handleInput(save ? "\r" : "\u001b");
          }
          return result;
        },
      },
    } as unknown as ExtensionContext;
    const result = await showRankings(ctx, original, new Map());
    if (save) {
      expect(result?.accounts.map((a) => a.id)).toEqual(["two", "one"]);
      expect(result?.accounts[1]?.alias).toBe("Personal");
    } else expect(result).toBeUndefined();
    expect(original.map((a) => [a.id, a.alias])).toEqual([
      ["one", undefined],
      ["two", undefined],
    ]);
  }
});
test("combined router stages default separately from fallbacks and cancels all pending changes", async () => {
  const keys = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.models.reorderDown": { defaultKeys: "d", description: "Rank down" },
  });
  const original = [
    { ...account("one"), alias: "Personal" },
    { ...account("two"), alias: "Work" },
  ];
  for (const save of [true, false]) {
    let screens = 0;
    const ctx = {
      mode: "tui",
      ui: {
        select: async (_title: string, labels: string[]) => {
          // The pending fallback order is Work, Personal. Choose Work as default separately.
          expect(labels).toEqual(["1. Work", "2. Personal ✓"]);
          return labels[0];
        },
        custom: async (factory: (...args: any[]) => any) => {
          let result: unknown;
          const view = factory(
            { terminal: { rows: 12 }, requestRender() {} },
            theme,
            keys,
            (value: unknown) => {
              result = value;
            },
          );
          const text = () => view.render(120).join("\n");
          expect(text()).not.toContain("Router");
          expect(text()).not.toContain("Ranked fallbacks");
          expect(text()).not.toContain("this session");
          if (!screens++) {
            expect(view.render(120).slice(1, -1)).toEqual([
              " Test: Personal",
              " > 1. Personal",
              "   2. Work",
              " a account · /d rank · n alias · e email · enter save · escape cancel",
            ]);
            view.handleInput("d");
            expect(text()).toContain("Test: Personal");
            view.handleInput("a");
          } else {
            expect(text()).toContain("Test: Work");
            for (const width of [1, 20, 80]) {
              expect(view.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(
                true,
              );
              expect(view.render(width).length).toBeLessThanOrEqual(12);
            }
            view.handleInput(save ? "\r" : "\u001b");
          }
          return result;
        },
      },
    } as unknown as ExtensionContext;
    const initialDefault = { provider: "test", accountId: "one" };
    const result = await showRankings(ctx, original, new Map([["test", "Test"]]), new Map(), [
      initialDefault,
    ]);
    if (save) {
      expect(result?.accounts.map((a) => a.id)).toEqual(["two", "one"]);
      expect(result?.sessionDefaults).toEqual([{ provider: "test", accountId: "two" }]);
    } else expect(result).toBeUndefined();
    expect(initialDefault.accountId).toBe("one");
    expect(original.map((a) => a.id)).toEqual(["one", "two"]);
  }
});

test("each provider has one header with its own default and account action", async () => {
  const accounts = [
    { ...account("one", "openai"), alias: "Personal" },
    { ...account("two", "openai"), alias: "Work" },
    { ...account("three", "xai"), alias: "Home" },
    { ...account("four", "xai"), alias: "Office" },
  ];
  const defaults = [
    { provider: "openai", accountId: "one" },
    { provider: "xai", accountId: "three" },
  ];
  let screens = 0;
  const ctx = {
    mode: "tui",
    ui: {
      select: async (title: string, labels: string[]) => {
        expect(title).toBe("xAI");
        expect(labels).toEqual(["1. Home ✓", "2. Office"]);
        return labels[1];
      },
      custom: async (factory: (...args: any[]) => any) => {
        let result: unknown;
        const view = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          theme,
          new KeybindingsManager(TUI_KEYBINDINGS),
          (value: unknown) => {
            result = value;
          },
        );
        const rows = view.render(120);
        expect(rows.filter((line: string) => line.includes("OpenAI"))).toEqual([
          " OpenAI: Personal",
        ]);
        expect(rows.filter((line: string) => line.includes("xAI"))).toEqual([
          screens ? " xAI: Office" : " xAI: Home",
        ]);
        if (!screens++) {
          view.handleInput("\u001b[B");
          view.handleInput("\u001b[B");
          view.handleInput("a");
        } else {
          expect(rows).toContain(" > 1. Home");
          view.handleInput("\r");
        }
        return result;
      },
    },
  } as unknown as ExtensionContext;
  const result = await showRankings(
    ctx,
    accounts,
    new Map([
      ["openai", "OpenAI"],
      ["xai", "xAI"],
    ]),
    new Map(),
    defaults,
  );
  expect(result?.sessionDefaults).toEqual([
    { provider: "openai", accountId: "one" },
    { provider: "xai", accountId: "four" },
  ]);
  expect(result?.accounts).toEqual(accounts);
  expect(defaults[1]?.accountId).toBe("three");
});

test("native alias input validates, clears, and cancels without changing account identity", async () => {
  const answers = ["bad\u001b[31m", "  Work  ", "", undefined];
  const warnings: string[] = [];
  const ctx = {
    ui: { input: async () => answers.shift(), notify: (text: string) => warnings.push(text) },
  } as unknown as ExtensionContext;
  const initial = account("one");
  const named = await promptAlias(ctx, initial, "Test");
  expect(named).toEqual({ ...initial, alias: "Work" });
  expect(warnings).toHaveLength(1);
  expect((await promptAlias(ctx, named, "Test")).alias).toBeUndefined();
  expect(await promptAlias(ctx, named, "Test")).toBe(named);
});
