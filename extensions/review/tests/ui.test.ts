import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { defaultSettings, ReviewLoopSettingsStore } from "../settings.ts";
import {
  formatLoopProgressLine,
  NumberedSelectList,
  reviewTargetItems,
  sanitizeSelectItems,
  showReviewLoopSettings,
} from "../ui.ts";

async function exerciseSettingsEditor(editorResult: string | undefined): Promise<{
  customCalls: number;
  editorCalls: number;
  store: ReviewLoopSettingsStore;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "review-loop-ui-"));
  const path = join(directory, "settings.json");
  const store = new ReviewLoopSettingsStore(defaultSettings(), path);
  let customCalls = 0;
  let editorCalls = 0;
  let customActive = false;
  type CustomFactory = (
    tui: { requestRender(): void },
    theme: {
      fg(_color: string, text: string): string;
      bold(text: string): string;
    },
    keybindings: { matches(): boolean },
    done: (value: unknown) => void,
  ) => Component;
  const context = {
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
      find: () => undefined,
    },
    ui: {
      custom: (factory: unknown) =>
        new Promise<unknown>((resolvePromise) => {
          customCalls += 1;
          customActive = true;
          const done = (value: unknown) => {
            customActive = false;
            resolvePromise(value);
          };
          const component = (factory as CustomFactory)(
            { requestRender: () => undefined },
            {
              fg: (_color, text) => text,
              bold: (text) => text,
            },
            { matches: () => false },
            done,
          );
          assert.match(component.render(160).join("\n"), /Review agents/);
          if (customCalls === 1) {
            for (let index = 0; index < 10; index += 1) component.handleInput?.("\u001b[B");
            component.handleInput?.("\r");
            component.handleInput?.("\r");
          } else {
            component.handleInput?.("\u001b");
          }
        }),
      editor: async () => {
        assert.equal(customActive, false, "editor must open only after custom settings UI closes");
        editorCalls += 1;
        return editorResult;
      },
      notify: () => undefined,
    },
  } as unknown as ExtensionCommandContext;

  await showReviewLoopSettings(context, defaultSettings(), store);
  return { customCalls, editorCalls, store, path };
}

test("closes and reopens settings around editor save", async () => {
  const result = await exerciseSettingsEditor("  pnpm test  ");
  assert.equal(result.customCalls, 2);
  assert.equal(result.editorCalls, 1);
  assert.equal(result.store.get().verificationCommand, "pnpm test");
  assert.match(await readFile(result.path, "utf8"), /"verificationCommand": "pnpm test"/);
});

test("reopens settings after editor cancellation", async () => {
  const result = await exerciseSettingsEditor(undefined);
  assert.equal(result.customCalls, 2);
  assert.equal(result.editorCalls, 1);
  assert.equal(result.store.get().verificationCommand, undefined);
});

test("numbered target lists render and immediately activate shortcuts", () => {
  const items = [
    ...reviewTargetItems(),
    { value: "custom", label: "Add custom review instructions" },
  ];
  const list = new NumberedSelectList(
    items,
    items.length,
    {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
      description: (text) => text,
      scrollInfo: (text) => text,
      noMatch: (text) => text,
    },
    5,
  );
  const selected: string[] = [];
  list.onSelect = (item) => selected.push(item.value);

  const rendered = list.render(120).join("\n");
  assert.match(rendered, /1\. Review uncommitted changes/);
  assert.match(rendered, /5\. Review a folder/);
  assert.doesNotMatch(rendered, /6\. Add custom review instructions/);

  list.handleInput("3");
  list.handleInput("5");
  list.handleInput("6");
  assert.deepEqual(selected, ["commit", "folder"]);
});

test("sanitizes model selector labels and descriptions", () => {
  const [item] = sanitizeSelectItems([
    {
      value: "provider/model",
      label: "Model\u001b]52;c;Y2xpcGJvYXJk\u0007 Name",
      description: "provider/\u001b[31mmodel\u001b[0m",
    },
  ]);
  assert.equal(item?.label, "Model Name");
  assert.equal(item?.description, "provider/model");
});

test("keeps Pi's standard working marker visible throughout loop progress", () => {
  assert.equal(
    formatLoopProgressLine(
      {
        phase: "reviewing",
        pass: 2,
        maximumPasses: 4,
        detail: "running a fresh independent review",
      },
      false,
    ),
    "Working... · Review loop · pass 2/4 · running a fresh independent review",
  );
  assert.match(
    formatLoopProgressLine({ phase: "verifying", pass: 3, maximumPasses: "unlimited" }, true),
    /^Working\.\.\. · Review loop · pass 3 · stopping$/,
  );
});
