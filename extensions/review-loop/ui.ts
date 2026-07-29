import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionCommandContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type Focusable,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { supportedThinkingLevels } from "./child-session.ts";
import type {
  ModelReference,
  ProgressUpdate,
  ReviewLoopResult,
  ReviewLoopSettings,
} from "./models.ts";
import { formatModelReference } from "./models.ts";
import { sanitizeTerminalText } from "./renderers.ts";
import { ReviewLoopSettingsStore } from "./settings.ts";

function selectTheme(theme: ExtensionCommandContext["ui"]["theme"]) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", sanitizeTerminalText(text)),
    selectedText: (text: string) => theme.fg("accent", sanitizeTerminalText(text)),
    description: (text: string) => theme.fg("muted", sanitizeTerminalText(text)),
    scrollInfo: (text: string) => theme.fg("dim", sanitizeTerminalText(text)),
    noMatch: (text: string) => theme.fg("warning", sanitizeTerminalText(text)),
  };
}

function settingsListTheme(theme: ExtensionCommandContext["ui"]["theme"]): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg("accent", text) : text),
    value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
    description: (text) => theme.fg("dim", text),
    cursor: theme.fg("accent", "→ "),
    hint: (text) => theme.fg("dim", text),
  };
}

export function sanitizeSelectItems(items: readonly SelectItem[]): SelectItem[] {
  return items.map((item) => ({
    ...item,
    label: sanitizeTerminalText(item.label),
    description:
      item.description === undefined ? undefined : sanitizeTerminalText(item.description),
  }));
}

export class SearchablePicker extends Container implements Focusable {
  private readonly input = new Input();
  private readonly listContainer = new Container();
  private filtered: SelectItem[];
  private list: SelectList | undefined;
  private _focused = false;
  private readonly items: SelectItem[];
  private readonly tui: TUI;
  private readonly keybindings: KeybindingsManager;
  private readonly theme: ExtensionCommandContext["ui"]["theme"];
  private readonly onSelectValue: (value: string) => void;
  private readonly onCancelValue: () => void;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    items: SelectItem[],
    tui: TUI,
    keybindings: KeybindingsManager,
    theme: ExtensionCommandContext["ui"]["theme"],
    onSelectValue: (value: string) => void,
    onCancelValue: () => void,
    title?: string,
    framed = true,
  ) {
    super();
    const sanitizedItems = sanitizeSelectItems(items);
    this.items = sanitizedItems;
    this.tui = tui;
    this.keybindings = keybindings;
    this.theme = theme;
    this.onSelectValue = onSelectValue;
    this.onCancelValue = onCancelValue;
    this.filtered = sanitizedItems;
    if (framed) this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    if (title) {
      this.addChild(new Text(theme.fg("accent", theme.bold(sanitizeTerminalText(title)))));
    }
    this.addChild(this.input);
    this.addChild(new Spacer(1));
    this.addChild(this.listContainer);
    this.addChild(new Text(theme.fg("dim", "Type to filter • enter to select • esc to cancel")));
    if (framed) this.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    this.rebuild();
  }

  private rebuild(): void {
    this.listContainer.clear();
    this.list = new SelectList(
      this.filtered,
      Math.min(Math.max(this.filtered.length, 1), 10),
      selectTheme(this.theme),
    );
    this.list.onSelect = (item) => this.onSelectValue(item.value);
    this.list.onCancel = this.onCancelValue;
    this.listContainer.addChild(this.list);
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "tui.select.up") ||
      this.keybindings.matches(data, "tui.select.down") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.list?.handleInput(data);
    } else {
      this.input.handleInput(data);
      const query = this.input.getValue();
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      this.filtered =
        words.length === 0
          ? this.items
          : this.items.filter((item) => {
              const haystack =
                `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase();
              return words.every((word) => haystack.includes(word));
            });
      this.rebuild();
    }
    this.tui.requestRender();
  }
}

export type TargetChoice = "uncommitted" | "baseBranch" | "commit" | "pullRequest" | "folder";

const TARGET_ITEMS: SelectItem[] = [
  { value: "uncommitted", label: "Review uncommitted changes" },
  { value: "baseBranch", label: "Review against a base branch", description: "(local)" },
  { value: "commit", label: "Review a commit" },
  { value: "pullRequest", label: "Review a pull request", description: "(GitHub PR)" },
  { value: "folder", label: "Review a folder (or more)", description: "(snapshot, not diff)" },
];

export async function showTargetSelector(
  ctx: ExtensionCommandContext,
  smartDefault: "uncommitted" | "baseBranch" | "commit",
): Promise<TargetChoice | undefined> {
  return ctx.ui.custom<TargetChoice | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select a review target"))));
    const list = new SelectList(TARGET_ITEMS, TARGET_ITEMS.length, selectTheme(theme));
    list.setSelectedIndex(TARGET_ITEMS.findIndex((item) => item.value === smartDefault));
    list.onSelect = (item) => done(item.value as TargetChoice);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "Press enter to confirm or esc to go back")));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function showSearchableSelection(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, keybindings, done) =>
      new SearchablePicker(items, tui, keybindings, theme, done, () => done(undefined), title),
  );
}

function modelReferenceFromValue(value: string): ModelReference | undefined {
  if (value === "__current__") return undefined;
  const separator = value.indexOf("/");
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function currentModelValue(reference: ModelReference | undefined): string {
  return reference ? sanitizeTerminalText(formatModelReference(reference)) : "current model";
}

function currentThinkingValue(level: ModelThinkingLevel | undefined): string {
  return level ?? "current level";
}

function modelForReference(
  ctx: ExtensionCommandContext,
  reference: ModelReference | undefined,
): Model<Api> | undefined {
  return reference ? ctx.modelRegistry.find(reference.provider, reference.modelId) : ctx.model;
}

interface SettingsEditorRequest {
  id: "verificationCommand" | "reviewInstructions";
  title: string;
  current: string | undefined;
}

type SettingsViewResult = { edit: SettingsEditorRequest } | undefined;

export async function showReviewLoopSettings(
  ctx: ExtensionCommandContext,
  initial: ReviewLoopSettings,
  store = new ReviewLoopSettingsStore(initial),
): Promise<void> {
  const modelItems: SelectItem[] = [
    {
      value: "__current__",
      label: "current model",
      description: "resolve from outer session at run start",
    },
    ...ctx.modelRegistry
      .getAvailable()
      .slice()
      .sort((left, right) =>
        `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
      )
      .map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: sanitizeTerminalText(model.name || model.id),
        description: sanitizeTerminalText(`${model.provider}/${model.id}`),
      })),
  ];
  const pendingWrites: Promise<void>[] = [];

  const queueWrite = (update: (value: ReviewLoopSettings) => void): void => {
    const write = store.update(update);
    pendingWrites.push(write);
    write.catch((error) => {
      ctx.ui.notify(
        sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
        "error",
      );
    });
  };

  const result = await ctx.ui.custom<SettingsViewResult>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Review loop settings"))));
    let settings = store.get();
    let settingsList: SettingsList;

    const save = (
      id: string,
      displayValue: string,
      update: (value: ReviewLoopSettings) => void,
    ): void => {
      queueWrite(update);
      settings = store.get();
      settingsList.updateValue(id, displayValue);
      tui.requestRender();
    };

    const choiceSubmenu = (
      title: string,
      items: SelectItem[],
      onSelect: (value: string) => void,
      close: (selectedValue?: string) => void,
    ): Component =>
      new SearchablePicker(
        items,
        tui,
        keybindings,
        theme,
        (value) => {
          onSelect(value);
          close();
        },
        () => close(),
        title,
        false,
      );

    const editorSubmenu = (
      id: "verificationCommand" | "reviewInstructions",
      title: string,
      current: string | undefined,
      close: (selectedValue?: string) => void,
    ): Component => {
      const list = new SelectList(
        [
          { value: "edit", label: "Edit" },
          { value: "clear", label: "Clear" },
        ],
        2,
        selectTheme(theme),
      );
      list.onCancel = () => close();
      list.onSelect = (item) => {
        if (item.value === "clear") {
          save(id, "none", (value) => delete value[id]);
          close();
          return;
        }
        done({ edit: { id, title, current } });
      };
      return list;
    };

    const items: SettingItem[] = [
      {
        id: "reviewerModel",
        label: "Reviewer model",
        currentValue: currentModelValue(settings.reviewerModel),
        submenu: (_current, close) =>
          choiceSubmenu(
            "Reviewer model",
            modelItems,
            (selected) => {
              const reference = modelReferenceFromValue(selected);
              save("reviewerModel", currentModelValue(reference), (value) => {
                if (reference) value.reviewerModel = reference;
                else delete value.reviewerModel;
              });
            },
            close,
          ),
      },
      {
        id: "reviewerThinking",
        label: "Reviewer thinking",
        currentValue: currentThinkingValue(settings.reviewerThinking),
        submenu: (_current, close) => {
          const model = modelForReference(ctx, settings.reviewerModel);
          const levels = supportedThinkingLevels(model);
          const choices: SelectItem[] = [
            { value: "__current__", label: "current level" },
            ...levels.map((level) => ({ value: level, label: level })),
          ];
          return choiceSubmenu(
            "Reviewer thinking",
            choices,
            (selected) => {
              const level =
                selected === "__current__" ? undefined : (selected as ModelThinkingLevel);
              save("reviewerThinking", currentThinkingValue(level), (value) => {
                if (level) value.reviewerThinking = level;
                else delete value.reviewerThinking;
              });
            },
            close,
          );
        },
      },
      {
        id: "fixerModel",
        label: "Fixer model",
        currentValue: currentModelValue(settings.fixerModel),
        submenu: (_current, close) =>
          choiceSubmenu(
            "Fixer model",
            modelItems,
            (selected) => {
              const reference = modelReferenceFromValue(selected);
              save("fixerModel", currentModelValue(reference), (value) => {
                if (reference) value.fixerModel = reference;
                else delete value.fixerModel;
              });
            },
            close,
          ),
      },
      {
        id: "fixerThinking",
        label: "Fixer thinking",
        currentValue: currentThinkingValue(settings.fixerThinking),
        submenu: (_current, close) => {
          const model = modelForReference(ctx, settings.fixerModel);
          const levels = supportedThinkingLevels(model);
          const choices: SelectItem[] = [
            { value: "__current__", label: "current level" },
            ...levels.map((level) => ({ value: level, label: level })),
          ];
          return choiceSubmenu(
            "Fixer thinking",
            choices,
            (selected) => {
              const level =
                selected === "__current__" ? undefined : (selected as ModelThinkingLevel);
              save("fixerThinking", currentThinkingValue(level), (value) => {
                if (level) value.fixerThinking = level;
                else delete value.fixerThinking;
              });
            },
            close,
          );
        },
      },
      {
        id: "maximumPasses",
        label: "Maximum passes",
        description: "total review passes before the loop stops; unlimited disables this cap",
        currentValue: String(settings.maximumPasses),
        submenu: (_current, close) =>
          choiceSubmenu(
            "Maximum passes",
            [
              { value: "unlimited", label: "unlimited", description: "no pass cap" },
              ...Array.from({ length: 20 }, (_value, index) => {
                const value = String(index + 1);
                return { value, label: value };
              }),
            ],
            (selected) => {
              const maximumPasses = selected === "unlimited" ? "unlimited" : Number(selected);
              save("maximumPasses", selected, (value) => {
                value.maximumPasses = maximumPasses;
                if (maximumPasses !== "unlimited") {
                  value.requiredCleanRuns = Math.min(value.requiredCleanRuns, maximumPasses);
                }
              });
              settingsList.updateValue("requiredCleanRuns", String(settings.requiredCleanRuns));
            },
            close,
          ),
      },
      {
        id: "requiredCleanRuns",
        label: "Required clean runs",
        description: "consecutive clean reviews required for success",
        currentValue: String(settings.requiredCleanRuns),
        submenu: (_current, close) =>
          choiceSubmenu(
            "Required clean runs",
            Array.from(
              { length: settings.maximumPasses === "unlimited" ? 20 : settings.maximumPasses },
              (_value, index) => {
                const value = String(index + 1);
                return { value, label: value };
              },
            ),
            (selected) => {
              const requiredCleanRuns = Number(selected);
              save("requiredCleanRuns", selected, (value) => {
                value.requiredCleanRuns = requiredCleanRuns;
              });
            },
            close,
          ),
      },
      {
        id: "fixP3Findings",
        label: "Fix P3 findings",
        currentValue: settings.fixP3Findings ? "yes" : "no",
        values: ["yes", "no"],
      },
      {
        id: "fixerContext",
        label: "Fixer context",
        currentValue: settings.fixerContext,
        values: ["continuous", "fresh"],
      },
      {
        id: "verificationCommand",
        label: "Verification command",
        currentValue: settings.verificationCommand ? "set" : "none",
        submenu: (_current, close) =>
          editorSubmenu(
            "verificationCommand",
            "Verification command",
            settings.verificationCommand,
            close,
          ),
      },
      {
        id: "reviewInstructions",
        label: "Review instructions",
        currentValue: settings.reviewInstructions ? "set" : "none",
        submenu: (_current, close) =>
          editorSubmenu(
            "reviewInstructions",
            "Shared review instructions",
            settings.reviewInstructions,
            close,
          ),
      },
    ];

    settingsList = new SettingsList(
      items,
      14,
      settingsListTheme(theme),
      (id, newValue) => {
        switch (id) {
          case "fixP3Findings":
            save(id, newValue, (value) => {
              value.fixP3Findings = newValue === "yes";
            });
            break;
          case "fixerContext":
            save(id, newValue, (value) => {
              value.fixerContext = newValue as "continuous" | "fresh";
            });
            break;
        }
      },
      () => done(undefined),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    container.addChild(
      new Text(theme.fg("dim", "Press enter to change a setting or esc to go back")),
    );
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result) {
    const edited = await ctx.ui.editor(result.edit.title, result.edit.current ?? "");
    if (edited !== undefined) {
      const normalized = edited.trim() || undefined;
      queueWrite((value) => {
        if (normalized) value[result.edit.id] = normalized;
        else delete value[result.edit.id];
      });
    }
    await showReviewLoopSettings(ctx, store.get(), store);
  }

  await Promise.allSettled(pendingWrites);
  await store.flush();
}

export function formatLoopProgressLine(update: ProgressUpdate, stopping: boolean): string {
  const pass =
    update.pass <= 0
      ? ""
      : update.maximumPasses === "unlimited"
        ? ` · pass ${update.pass}`
        : ` · pass ${update.pass}/${update.maximumPasses}`;
  const detail = stopping ? "stopping" : (update.detail ?? update.phase.replaceAll("-", " "));
  // Keep Pi's standard visible working marker present for the full lifetime
  // of this blocking custom command so screen-state detection remains accurate.
  return sanitizeTerminalText(`Working... · Review loop${pass} · ${detail}`);
}

class LoopProgressComponent implements Component {
  readonly controller = new AbortController();
  private readonly topBorder: DynamicBorder;
  private readonly bottomBorder: DynamicBorder;
  private update: ProgressUpdate = { phase: "resolving-target", pass: 0, maximumPasses: 1 };
  private stopping = false;
  private readonly theme: ExtensionCommandContext["ui"]["theme"];
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;

  constructor(
    theme: ExtensionCommandContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    requestRender: () => void,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
    this.bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
  }

  setUpdate(update: ProgressUpdate): void {
    this.update = update;
    this.requestRender();
  }

  render(width: number): string[] {
    return [
      ...this.topBorder.render(width),
      truncateToWidth(
        this.theme.fg("accent", ` ${formatLoopProgressLine(this.update, this.stopping)}`),
        width,
      ),
      truncateToWidth(this.theme.fg("dim", " esc stop"), width),
      ...this.bottomBorder.render(width),
    ];
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") && !this.controller.signal.aborted) {
      this.stopping = true;
      this.controller.abort();
      this.requestRender();
    }
  }

  invalidate(): void {
    this.topBorder.invalidate();
    this.bottomBorder.invalidate();
  }
}

interface ProgressEnvelope {
  result?: ReviewLoopResult;
  error?: unknown;
}

export async function showLoopProgress(
  ctx: ExtensionCommandContext,
  run: (signal: AbortSignal, update: (value: ProgressUpdate) => void) => Promise<ReviewLoopResult>,
  onController?: (controller: AbortController | undefined) => void,
): Promise<ReviewLoopResult> {
  const envelope = await ctx.ui.custom<ProgressEnvelope>((tui, theme, keybindings, done) => {
    const component = new LoopProgressComponent(theme, keybindings, () => tui.requestRender());
    onController?.(component.controller);
    void run(component.controller.signal, (update) => component.setUpdate(update))
      .then((result) => done({ result }))
      .catch((error) => done({ error }));
    return component;
  });
  onController?.(undefined);
  if (envelope.error) throw envelope.error;
  if (!envelope.result) throw new Error("Review loop UI closed without a result.");
  return envelope.result;
}
