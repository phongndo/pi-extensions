import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { DynamicBorder, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  getSelectPageIndex,
  Input,
  Spacer,
  Text,
  type Focusable,
} from "@earendil-works/pi-tui";

const MAX_VISIBLE = 10;

export type PickerResult =
  | { kind: "off" }
  | { kind: "model"; model: Model<Api>; thinking: ModelThinkingLevel };

type Item = { kind: "off" } | { kind: "model"; model: Model<Api> };

export interface AdvisorPickerOptions {
  theme: Theme;
  /** Every model with credentials. */
  models: readonly Model<Api>[];
  /** The session's scoped models; when present the picker opens on them and Tab switches scope. */
  scoped: readonly Model<Api>[];
  current?: { model: Model<Api> | undefined; thinking: ModelThinkingLevel };
  /** Thinking level preselected when no advisor is set. */
  defaultThinking: ModelThinkingLevel;
  initialSearch?: string;
  done: (result: PickerResult | undefined) => void;
}

/** Same ranking text as Pi's /model search: provider-prefixed ids lead, the name trails. */
function searchText(item: Item): string {
  if (item.kind === "off") return "off none disable";
  const { id, provider, name } = item.model;
  return `${provider} ${provider}/${id} ${provider} ${id}${name ? ` ${name}` : ""}`;
}

const words = (value: string) =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Pi's rule: show the name only when it says something the id does not. */
function distinctName(model: Model<Api>): string | undefined {
  const name = model.name?.trim();
  if (!name) return undefined;
  const idWords = words(model.id);
  const tokens = new Set(idWords);
  const compact = idWords.join("");
  const covered = (word: string) => tokens.has(word) || (word.length > 1 && compact.includes(word));
  return words(name).every(covered) ? undefined : name;
}

/** Model picker for the advisor, laid out and keyed like Pi's own /model selector. */
export class AdvisorPicker extends Container implements Focusable {
  private readonly search = new Input();
  private readonly header = new Text("", 0, 0);
  private readonly list = new Container();
  private readonly status = new Text("", 0, 0);
  private readonly opts: AdvisorPickerOptions;
  private readonly allItems: Item[];
  private readonly scopedItems: Item[];
  private scope: "all" | "scoped";
  private items: Item[] = [];
  private selected = 0;
  /** The level the user wants; each model shows it clamped to what that model supports. */
  private thinking: ModelThinkingLevel;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.search.focused = value;
  }

  constructor(opts: AdvisorPickerOptions) {
    super();
    this.opts = opts;
    this.thinking = opts.current?.thinking ?? opts.defaultThinking;
    const currentFirst = (models: readonly Model<Api>[]): Item[] => [
      { kind: "off" },
      ...[...models]
        .sort(
          (a, b) =>
            Number(this.isCurrent(b)) - Number(this.isCurrent(a)) ||
            a.provider.localeCompare(b.provider),
        )
        .map((model): Item => ({ kind: "model", model })),
    ];
    this.allItems = currentFirst(opts.models);
    this.scopedItems = currentFirst(opts.scoped);
    this.scope = opts.scoped.length > 0 ? "scoped" : "all";

    const { theme } = opts;
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.header);
    this.addChild(new Spacer(1));
    this.addChild(this.search);
    this.addChild(new Spacer(1));
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.status);
    this.addChild(
      new Text(
        theme.fg(
          "dim",
          `  ${[
            keyHint("tui.select.confirm", "select"),
            keyHint("app.thinking.cycle", "thinking"),
            ...(opts.scoped.length > 0 ? [keyHint("tui.input.tab", "scope")] : []),
            keyHint("tui.select.cancel", "cancel"),
          ].join(" · ")}`,
        ),
        0,
        0,
      ),
    );
    this.addChild(new DynamicBorder());

    // Like /model: a search opens on its best match, otherwise on the current advisor.
    if (opts.initialSearch) this.search.setValue(opts.initialSearch);
    this.filter(!opts.initialSearch);
  }

  private isCurrent(model: Model<Api>): boolean {
    return modelsAreEqual(this.opts.current?.model, model);
  }

  private selectedItem(): Item | undefined {
    return this.items[this.selected];
  }

  private filter(selectCurrent = false): void {
    const pool = this.scope === "scoped" ? this.scopedItems : this.allItems;
    const query = this.search.getValue().trim();
    this.items = query ? fuzzyFilter(pool, query, searchText) : pool;
    if (selectCurrent) {
      const current = this.opts.current?.model;
      const index = this.items.findIndex((item) =>
        current ? item.kind === "model" && this.isCurrent(item.model) : item.kind === "off",
      );
      this.selected = index >= 0 ? index : 0;
    } else {
      this.selected = query ? 0 : Math.min(this.selected, Math.max(0, this.items.length - 1));
    }
    this.update();
  }

  private update(): void {
    const { theme } = this.opts;
    const scope =
      this.opts.scoped.length > 0
        ? `${theme.fg("muted", "  Scope: ")}${theme.fg(this.scope === "all" ? "accent" : "muted", "all")}${theme.fg("muted", " | ")}${theme.fg(this.scope === "scoped" ? "accent" : "muted", "scoped")}`
        : "";
    this.header.setText(`${theme.fg("accent", theme.bold("Advisor model"))}${scope}`);

    this.list.clear();
    const start = Math.max(
      0,
      Math.min(this.selected - Math.floor(MAX_VISIBLE / 2), this.items.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.items.length);
    for (let index = start; index < end; index++) {
      const item = this.items[index];
      if (!item) continue;
      const isSelected = index === this.selected;
      const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
      let line: string;
      if (item.kind === "off") {
        const marker = this.opts.current?.model ? "  " : theme.fg("accent", "✓ ");
        line = `${cursor}${marker}${isSelected ? theme.fg("accent", "off") : "off"}${theme.fg("muted", " (disable the advisor)")}`;
      } else {
        const { model } = item;
        const marker = this.isCurrent(model) ? theme.fg("accent", "✓ ") : "  ";
        const distinct = distinctName(model);
        const name = distinct ? theme.fg("muted", ` (${distinct})`) : "";
        line = `${cursor}${marker}${isSelected ? theme.fg("accent", model.id) : model.id}${name} ${theme.fg("muted", `[${model.provider}]`)}`;
      }
      this.list.addChild(new Text(line, 0, 0));
    }
    if (start > 0 || end < this.items.length) {
      this.list.addChild(
        new Text(theme.fg("muted", `  (${this.selected + 1}/${this.items.length})`), 0, 0),
      );
    }
    if (this.items.length === 0) {
      this.list.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
    }

    const item = this.selectedItem();
    if (item?.kind === "model") {
      const level = clampThinkingLevel(item.model, this.thinking);
      this.status.setText(
        item.model.reasoning
          ? `${theme.fg("muted", "  Thinking: ")}${theme.fg(level === "off" ? "muted" : "accent", level)}`
          : theme.fg("muted", "  Thinking: not supported"),
      );
    } else {
      this.status.setText(theme.fg("muted", "  Turns the advisor tool off."));
    }
  }

  private cycleThinking(): void {
    const item = this.selectedItem();
    if (item?.kind !== "model" || !item.model.reasoning) return;
    const levels = getSupportedThinkingLevels(item.model);
    const current = levels.indexOf(clampThinkingLevel(item.model, this.thinking));
    this.thinking = levels[(current + 1) % levels.length] ?? this.thinking;
    this.update();
  }

  private confirm(): void {
    const item = this.selectedItem();
    if (!item) return;
    this.opts.done(
      item.kind === "off"
        ? { kind: "off" }
        : {
            kind: "model",
            model: item.model,
            thinking: clampThinkingLevel(item.model, this.thinking),
          },
    );
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    const page = getSelectPageIndex(kb, data, this.selected, this.items.length, MAX_VISIBLE);
    if (kb.matches(data, "app.thinking.cycle")) {
      this.cycleThinking();
    } else if (kb.matches(data, "tui.input.tab")) {
      if (this.opts.scoped.length === 0) return;
      this.scope = this.scope === "all" ? "scoped" : "all";
      this.filter(true);
    } else if (kb.matches(data, "tui.select.up")) {
      if (!this.items.length) return;
      this.selected = this.selected === 0 ? this.items.length - 1 : this.selected - 1;
      this.update();
    } else if (kb.matches(data, "tui.select.down")) {
      if (!this.items.length) return;
      this.selected = this.selected === this.items.length - 1 ? 0 : this.selected + 1;
      this.update();
    } else if (page !== undefined) {
      if (!this.items.length) return;
      this.selected = page;
      this.update();
    } else if (kb.matches(data, "tui.select.confirm")) {
      this.confirm();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.opts.done(undefined);
    } else {
      this.search.handleInput(data);
      this.filter();
    }
  }
}
