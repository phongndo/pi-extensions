import { expect, test } from "bun:test";
import { type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { NativeAccount } from "../../../src/account-identity.ts";
import { RankingList, showRankings, promptAlias } from "../ui.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);
const account = (id: string, provider = "test"): NativeAccount => ({
  id,
  name: id,
  alias: id,
  provider,
  credentialId: id,
  type: "oauth",
});
const up = "\u001b[A",
  down = "\u001b[B";
const rankUp = "\u001b[1;5A",
  rankDown = "\u001b[1;5B";
const rename = "\u000e",
  email = "\u0005";

test("Ctrl arrows rank within providers, follow selection, and leave original untouched", () => {
  const original = [account("a"), account("b"), account("c", "other")];
  let saved: NativeAccount[] | undefined;
  let selected = "";
  const view = new RankingList(
    original,
    new Map(),
    theme,
    keys(),
    (result) => {
      saved = result;
    },
    () => 24,
    (_accounts, id) => {
      selected = id;
    },
  );
  view.handleInput(rankUp);
  view.handleInput(rankDown);
  view.handleInput(rankDown);
  view.handleInput(rename);
  expect(selected).toBe("a");
  view.handleInput("\r");
  expect(saved?.map((a) => a.id)).toEqual(["b", "a", "c"]);
  view.handleInput(rankUp);
  view.handleInput("\r");
  expect(saved).toEqual(original);
  view.handleInput(rankDown);
  view.handleInput("\u001b");
  expect(saved).toBeUndefined();
  expect(original.map((a) => a.id)).toEqual(["a", "b", "c"]);
});

test("search accepts all letters including former shortcuts, supports backspace and no matches", () => {
  const view = new RankingList(
    [account("Jane"), account("Work", "codex")],
    new Map([["codex", "OpenAI"]]),
    theme,
    keys(),
    () => {},
    () => 24,
  );
  view.focused = true;
  expect(view.focused).toBe(true);
  for (const char of "JaneJK") view.handleInput(char);
  expect(view.query).toBe("JaneJK");
  expect(view.render(120).join("\n")).toContain("No matching accounts");
  for (const key of [down, up, rankUp, rankDown, " "]) view.handleInput(key);
  view.handleInput("\u007f");
  view.handleInput("\u007f");
  expect(view.render(120).join("\n")).toContain("1. Jane");
  expect(view.render(120).join("\n")).not.toContain("1. Work");
  view.handleInput("\u0015"); // Clear search.
  for (const char of "openai") view.handleInput(char);
  expect(view.render(120).join("\n")).toContain("1. Work");
  expect(view.render(120).join("\n")).not.toContain("1. Jane");
  for (const width of [1, 20, 40, 80])
    expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
});

test("filtered ranking moves one position in full order, without losing hidden accounts", () => {
  const original = [account("Visible"), account("Hidden"), account("Other", "other")];
  let saved: NativeAccount[] | undefined;
  const view = new RankingList(
    original,
    new Map(),
    theme,
    keys(),
    (result) => {
      saved = result;
    },
    () => 24,
  );
  for (const char of "visible") view.handleInput(char);
  view.handleInput(rankDown);
  expect(view.render(120).join("\n")).toContain("> 2. Visible");
  view.handleInput(rankDown);
  view.handleInput("\r");
  expect(saved?.map((a) => a.id)).toEqual(["Hidden", "Visible", "Other"]);
});

test("email is selected-only and concealed by navigation, ranking, search and alias actions", () => {
  const accounts = [account("One"), account("Two")];
  const view = new RankingList(
    accounts,
    new Map(),
    theme,
    keys(),
    () => {},
    () => 24,
    () => {},
    undefined,
    new Map([
      ["One", "one@example.test"],
      ["Two", "two@example.test"],
    ]),
  );
  const text = () => view.render(120).join("\n");
  expect(text()).not.toContain("example.test");
  view.handleInput(email);
  expect(text()).toContain("one@example.test");
  expect(text()).not.toContain("two@example.test");
  view.handleInput(email);
  expect(text()).not.toContain("example.test");
  for (const action of [down, rankUp, rename, "T"]) {
    view.handleInput(email);
    view.handleInput(action);
    expect(text()).not.toContain("example.test");
  }
});

test("scrolled rankings retain provider headers and stay within terminal bounds", () => {
  const accounts = Array.from({ length: 24 }, (_, i) =>
    account(`Label ${i}`, i < 12 ? "codex" : "xai"),
  );
  let renamed = "";
  const view = new RankingList(
    accounts,
    new Map([
      ["codex", "OpenAI Codex"],
      ["xai", "xAI"],
    ]),
    theme,
    keys(),
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
    view.handleInput(rename);
    expect(renamed).toBe(`Label ${i}`);
    view.handleInput(down);
  }
});

test("Space stages independent session defaults for multiple providers without a picker; Enter saves and Escape discards", async () => {
  const original = [
    account("Personal", "openai"),
    account("Work", "openai"),
    account("Home", "xai"),
    account("Office", "xai"),
  ];
  const defaults = [
    { provider: "openai", accountId: "Personal" },
    { provider: "xai", accountId: "Home" },
  ];
  for (const save of [true, false]) {
    const ctx = {
      mode: "tui",
      ui: {
        select: async () => {
          throw new Error("No picker should open");
        },
        custom: async (factory: (...args: any[]) => any) => {
          let result: unknown;
          const view = factory(
            { terminal: { rows: 24 }, requestRender() {} },
            theme,
            keys(),
            (value: unknown) => {
              result = value;
            },
          );
          const text = () => view.render(160).join("\n");
          expect(text()).toContain("1. Personal ✓");
          expect(text()).toContain("1. Home ✓");
          view.handleInput(down);
          view.handleInput(" ");
          expect(text()).toContain("openai: Work");
          expect(text()).toContain("2. Work ✓");
          expect(text()).not.toContain("Personal ✓");
          view.handleInput(rankUp);
          expect(text()).toContain("1. Work ✓");
          for (const char of "office") view.handleInput(char);
          view.handleInput(" ");
          expect(text()).toContain("xai: Office");
          expect(text()).toContain("2. Office ✓");
          view.handleInput(save ? "\r" : "\u001b");
          return result;
        },
      },
    } as unknown as ExtensionContext;
    const result = await showRankings(ctx, original, new Map(), new Map(), defaults);
    if (save) {
      expect(result?.sessionDefaults).toEqual([
        { provider: "openai", accountId: "Work" },
        { provider: "xai", accountId: "Office" },
      ]);
      expect(result?.accounts.map((a) => a.id)).toEqual(["Work", "Personal", "Home", "Office"]);
    } else expect(result).toBeUndefined();
    expect(defaults.map((d) => d.accountId)).toEqual(["Personal", "Home"]);
    expect(original.map((a) => a.id)).toEqual(["Personal", "Work", "Home", "Office"]);
  }
});

test("alias dialog preserves search, pending order and selection", async () => {
  let screens = 0;
  const ctx = {
    mode: "tui",
    ui: {
      input: async () => "One renamed",
      custom: async (factory: (...args: any[]) => any) => {
        let result: unknown;
        const view = factory(
          { terminal: { rows: 24 }, requestRender() {} },
          theme,
          keys(),
          (value: unknown) => {
            result = value;
          },
        );
        if (!screens++) {
          for (const char of "one") view.handleInput(char);
          view.handleInput(rankDown);
          view.handleInput(rename);
        } else {
          expect(view.query).toBe("one");
          expect(view.render(120).join("\n")).toContain("> 2. One renamed");
          view.handleInput("\r");
        }
        return result;
      },
    },
  } as unknown as ExtensionContext;
  const result = await showRankings(ctx, [account("One"), account("Two")], new Map());
  expect(result?.accounts.map((a) => a.alias)).toEqual(["Two", "One renamed"]);
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
