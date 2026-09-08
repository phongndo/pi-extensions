import {
  DynamicBorder,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { choiceAnswer, MAX_CUSTOM_ANSWER_LENGTH, OTHER_CHOICE } from "./answers.ts";
export { OTHER_CHOICE } from "./answers.ts";

const NUMBER_SHORTCUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MIN_OPTION_COLUMN_WIDTH = 32;
const MAX_OPTION_COLUMN_WIDTH = 90;
const MIN_SIDE_BY_SIDE_WIDTH = 96;
const MIN_DETAIL_COLUMN_WIDTH = 36;
const PANE_SEPARATOR = " │ ";
const OTHER_DESCRIPTION = "Optionally, add details in notes (tab).";

type Theme = ExtensionContext["ui"]["theme"];

export interface QuestionChoice {
  label: string;
  description?: string;
}

export interface DialogQuestion {
  id: string;
  question: string;
  options: QuestionChoice[];
  multiple: boolean;
}

export type DialogAnswers = Record<string, string[]>;

interface QuestionState {
  editor: Editor;
  focus: Focus;
  list?: NumberedSelectList;
  selectedIndex: number;
  selection:
    | { kind: "text" }
    | { kind: "single"; label?: string }
    | { kind: "multiple"; labels: Set<string> };
  customAnswer?: string;
  submission: { status: "draft" } | { status: "submitted"; values: [string, ...string[]] };
}

type Focus = "options" | "editor";

function selectTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

/** Pi's native SelectList with immediate 1–9 shortcuts and Vim/Tab navigation. */
export class NumberedSelectList extends SelectList {
  private readonly shortcutItems: SelectItem[];
  private readonly descriptionsByValue: ReadonlyMap<string, string>;
  private readonly preferredOptionPaneWidth: number;
  private readonly styleDescription: SelectListTheme["description"];

  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
    const count = Math.min(items.length, NUMBER_SHORTCUTS.length);
    const numberedItems = items.map((item, index) =>
      index < count ? { ...item, label: `${index + 1}. ${item.label}` } : item,
    );
    const compactItems = numberedItems.map(({ description: _description, ...item }) => item);
    const descriptionsByValue = new Map<string, string>();
    for (const item of numberedItems) {
      if (item.description) descriptionsByValue.set(item.value, item.description);
    }
    super(compactItems, maxVisible, theme, {
      minPrimaryColumnWidth: MIN_OPTION_COLUMN_WIDTH,
      maxPrimaryColumnWidth: MAX_OPTION_COLUMN_WIDTH,
    });
    this.shortcutItems = compactItems.slice(0, count);
    this.descriptionsByValue = descriptionsByValue;
    this.preferredOptionPaneWidth = Math.min(
      MAX_OPTION_COLUMN_WIDTH,
      Math.max(
        MIN_OPTION_COLUMN_WIDTH,
        ...compactItems.map((item) => visibleWidth(item.label) + 4),
      ),
    );
    this.styleDescription = theme.description;
  }

  private renderDetails(description: string, width: number, paddingX: number): string[] {
    return new Text(this.styleDescription(description), paddingX, 0).render(width);
  }

  override render(width: number): string[] {
    const selected = this.getSelectedItem();
    if (!selected || this.descriptionsByValue.size === 0) return super.render(width);

    const description = this.descriptionsByValue.get(selected.value) ?? "No additional details.";
    const separatorWidth = visibleWidth(PANE_SEPARATOR);
    const maxOptionPaneWidth = width - separatorWidth - MIN_DETAIL_COLUMN_WIDTH;
    if (width < MIN_SIDE_BY_SIDE_WIDTH || maxOptionPaneWidth < MIN_OPTION_COLUMN_WIDTH) {
      return [...super.render(width), ...this.renderDetails(description, width, 2)];
    }

    const optionPaneWidth = Math.min(this.preferredOptionPaneWidth, maxOptionPaneWidth);
    const detailPaneWidth = width - optionPaneWidth - separatorWidth;
    const optionLines = super.render(optionPaneWidth);
    const detailLines = this.renderDetails(description, detailPaneWidth, 0);
    const separator = this.styleDescription(PANE_SEPARATOR);
    const lineCount = Math.max(optionLines.length, detailLines.length);
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index++) {
      const optionLine = optionLines[index] ?? "";
      const optionPadding = " ".repeat(Math.max(0, optionPaneWidth - visibleWidth(optionLine)));
      lines.push(`${optionLine}${optionPadding}${separator}${detailLines[index] ?? ""}`);
    }
    return lines;
  }

  override handleInput(data: string): void {
    const index = NUMBER_SHORTCUTS.findIndex((shortcut) => matchesKey(data, shortcut));
    const item = this.shortcutItems[index];
    if (item) {
      this.onSelect?.(item);
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, Key.tab)) {
      super.handleInput("\u001b[B");
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, Key.shift("tab"))) {
      super.handleInput("\u001b[A");
      return;
    }
    super.handleInput(data);
  }
}

/** A single layered dialog following Codex's request-user-input interaction model. */
export class QuestionDialog extends Container implements Focusable {
  private readonly tui: TUI;
  private readonly keybindings: KeybindingsManager;
  private readonly theme: Theme;
  private readonly questions: DialogQuestion[];
  private readonly states: QuestionState[];
  private readonly done: (answers: DialogAnswers | undefined) => void;
  private readonly notify: (message: string) => void;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;
  private currentIndex = 0;
  private settled = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncEditorFocus();
  }

  constructor(
    tui: TUI,
    keybindings: KeybindingsManager,
    theme: Theme,
    questions: DialogQuestion[],
    signal: AbortSignal | undefined,
    notify: (message: string) => void,
    done: (answers: DialogAnswers | undefined) => void,
  ) {
    super();
    this.tui = tui;
    this.keybindings = keybindings;
    this.theme = theme;
    this.questions = questions;
    this.signal = signal;
    this.notify = notify;
    this.done = done;
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: selectTheme(theme),
    };
    this.states = questions.map((question, index) => {
      const editor = new Editor(tui, editorTheme, { paddingX: 1 });
      editor.onSubmit = (value) => this.submitEditor(index, value);
      editor.onChange = () => {
        const state = this.states[index];
        if (state) state.submission = { status: "draft" };
      };
      return {
        editor,
        focus: question.options.length ? "options" : "editor",
        selectedIndex: 0,
        selection:
          question.options.length === 0
            ? { kind: "text" }
            : question.multiple
              ? { kind: "multiple", labels: new Set<string>() }
              : { kind: "single" },
        submission: { status: "draft" },
      };
    });
    for (const index of this.questions.keys()) this.rebuildList(index);

    this.onAbort = () => this.finish(undefined);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    this.syncEditorFocus();
  }

  private get focus(): Focus {
    return this.currentState().focus;
  }

  private set focus(value: Focus) {
    this.currentState().focus = value;
  }

  private currentQuestion(): DialogQuestion {
    return this.questions[this.currentIndex]!;
  }

  private currentState(): QuestionState {
    return this.states[this.currentIndex]!;
  }

  private optionLabel(index: number, selectedIndex: number): string | undefined {
    const question = this.questions[index]!;
    return (
      question.options[selectedIndex]?.label ??
      (selectedIndex === question.options.length ? OTHER_CHOICE : undefined)
    );
  }

  private isAnswered(index: number): boolean {
    return this.states[index]!.submission.status === "submitted";
  }

  private unansweredCount(): number {
    return this.questions.reduce(
      (count, _question, index) => count + Number(!this.isAnswered(index)),
      0,
    );
  }

  private listChoices(index: number): QuestionChoice[] {
    const question = this.questions[index]!;
    const state = this.states[index]!;
    const choices = question.options.map((option) => {
      const selected =
        state.selection.kind === "multiple"
          ? state.selection.labels.has(option.label)
          : state.selection.kind === "single" && state.selection.label === option.label;
      return {
        label: `${option.label}${selected ? "  ✓" : ""}`,
        ...(option.description ? { description: option.description } : {}),
      };
    });
    const otherSelected =
      state.selection.kind === "multiple"
        ? state.selection.labels.has(OTHER_CHOICE)
        : state.selection.kind === "single" && state.selection.label === OTHER_CHOICE;
    choices.push({
      label: `${OTHER_CHOICE}${otherSelected ? "  ✓" : ""}`,
      description: OTHER_DESCRIPTION,
    });
    return choices;
  }

  private rebuildList(index: number): void {
    const question = this.questions[index]!;
    if (question.options.length === 0) return;
    const state = this.states[index]!;
    const choices = this.listChoices(index);
    const items: SelectItem[] = choices.map((choice, choiceIndex) => ({
      value: String(choiceIndex),
      label: choice.label,
      ...(choice.description ? { description: choice.description } : {}),
    }));
    const list = new NumberedSelectList(items, items.length, selectTheme(this.theme));
    list.setSelectedIndex(Math.min(state.selectedIndex, items.length - 1));
    list.onSelectionChange = (item) => {
      state.selectedIndex = Number(item.value);
    };
    list.onSelect = (item) => this.selectChoice(index, Number(item.value));
    list.onCancel = () => this.finish(undefined);
    state.list = list;
  }

  private markChoice(index: number, selectedIndex: number): boolean {
    const state = this.states[index]!;
    const label = this.optionLabel(index, selectedIndex);
    if (!label) return false;

    state.selectedIndex = selectedIndex;
    if (state.selection.kind === "multiple") {
      const labels = state.selection.labels;
      if (label === OTHER_CHOICE) {
        labels.clear();
        labels.add(label);
      } else {
        labels.delete(OTHER_CHOICE);
        if (labels.has(label)) labels.delete(label);
        else labels.add(label);
      }
    } else if (state.selection.kind === "single") {
      state.selection.label = label;
    } else return false;
    state.submission = { status: "draft" };
    this.rebuildList(index);
    return true;
  }

  private selectChoice(index: number, selectedIndex: number): void {
    if (index !== this.currentIndex || !this.markChoice(index, selectedIndex)) return;
    if (this.states[index]!.selection.kind === "multiple") {
      this.requestRender();
      return;
    }
    this.commitChoice(index);
    this.advanceOrFinish();
  }

  private openNotes(): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    if (question.options.length === 0) return;

    if (state.selection.kind !== "multiple" || state.selection.labels.size === 0) {
      this.markChoice(this.currentIndex, state.selectedIndex);
    }
    this.focus = "editor";
    if (!state.editor.getText() && state.customAnswer) state.editor.setText(state.customAnswer);
    this.syncEditorFocus();
    this.requestRender();
  }

  private clearNotesAndReturn(): void {
    const state = this.currentState();
    state.editor.setText("");
    delete state.customAnswer;
    state.submission = { status: "draft" };
    this.focus = "options";
    this.rebuildList(this.currentIndex);
    this.syncEditorFocus();
    this.requestRender();
  }

  private submitEditor(index: number, value: string): void {
    if (index !== this.currentIndex || this.focus !== "editor") return;
    const answer = value.trim();
    if (answer.length > MAX_CUSTOM_ANSWER_LENGTH) {
      this.notify(`Keep the answer under ${MAX_CUSTOM_ANSWER_LENGTH.toLocaleString()} characters.`);
      return;
    }

    const state = this.states[index]!;
    if (state.selection.kind === "text") {
      if (!answer) {
        this.notify("Enter an answer or press Escape to cancel.");
        return;
      }
      state.editor.setText(answer);
      state.submission = { status: "submitted", values: [answer] };
      this.advanceOrFinish();
      return;
    }

    if (state.selection.kind === "multiple" && state.selection.labels.size === 0) {
      this.markChoice(index, state.selectedIndex);
    } else if (state.selection.kind === "single" && !state.selection.label) {
      this.markChoice(index, state.selectedIndex);
    }
    if (answer) state.customAnswer = answer;
    else delete state.customAnswer;
    // Native Editor clears its buffer on submit; retain the confirmed note for revisiting.
    state.editor.setText(answer);
    this.commitChoice(index);
    this.advanceOrFinish();
  }

  private submitMultipleChoice(): void {
    const state = this.currentState();
    if (state.selection.kind !== "multiple") return;
    if (state.selection.labels.size === 0) this.markChoice(this.currentIndex, state.selectedIndex);
    this.commitChoice(this.currentIndex);
    this.advanceOrFinish();
  }

  private commitChoice(index: number): void {
    const state = this.states[index]!;
    const selection = state.selection;
    const selected =
      selection.kind === "multiple"
        ? selection.labels
        : new Set(selection.kind === "single" && selection.label ? [selection.label] : []);
    const values = choiceAnswer(
      this.questions[index]!.options,
      selected,
      state.customAnswer ? { kind: "note", text: state.customAnswer } : undefined,
    );
    state.submission = values ? { status: "submitted", values } : { status: "draft" };
  }

  private advanceOrFinish(): void {
    if (this.currentIndex < this.questions.length - 1) {
      this.goToQuestion(this.currentIndex + 1);
      return;
    }
    const firstUnanswered = this.questions.findIndex((_question, index) => !this.isAnswered(index));
    if (firstUnanswered >= 0) {
      this.notify("Answer the remaining question before submitting.");
      this.goToQuestion(firstUnanswered);
      return;
    }
    this.finish(this.collectAnswers());
  }

  private goToQuestion(index: number): void {
    if (this.questions.length < 2) return;
    const nextIndex = (index + this.questions.length) % this.questions.length;
    if (nextIndex === this.currentIndex) return;
    this.currentIndex = nextIndex;
    this.syncEditorFocus();
    this.requestRender();
  }

  private collectAnswers(): DialogAnswers {
    const answers: DialogAnswers = {};
    for (const [index, question] of this.questions.entries()) {
      const submission = this.states[index]!.submission;
      if (submission.status !== "submitted")
        throw new Error("Cannot collect an unsubmitted answer.");
      answers[question.id] = [...submission.values];
    }
    return answers;
  }

  private finish(value: DialogAnswers | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.done(value);
  }

  private syncEditorFocus(): void {
    for (const [index, state] of this.states.entries()) {
      state.editor.focused =
        this._focused && this.focus === "editor" && index === this.currentIndex;
    }
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  private editorLines(width: number): string[] {
    const prefix = " ";
    const indent = visibleWidth(prefix);
    const lines = this.currentState().editor.render(Math.max(1, width - indent));
    // Editor provides wrapping/cursor behavior; the dialog owns the surrounding border.
    return lines.slice(1, -1).map((line) => `${prefix}${line}`);
  }

  override render(width: number): string[] {
    const question = this.currentQuestion();
    const state = this.currentState();
    const unanswered = this.unansweredCount();
    const progress = `Question ${this.currentIndex + 1}/${this.questions.length}${unanswered > 0 ? ` (${unanswered} unanswered)` : ""}`;
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => this.theme.fg("accent", text)));
    container.addChild(new Text(this.theme.fg("dim", progress), 1, 0));
    container.addChild(new Text(this.theme.fg("accent", question.question), 1, 1));

    const rendered = container.render(width);
    if (question.options.length > 0) rendered.push(...state.list!.render(width));
    if (this.focus === "editor") {
      const editorHeading = question.options.length > 0 ? "Your note" : "Your answer";
      rendered.push("");
      rendered.push(...new Text(this.theme.fg("accent", editorHeading), 1, 0).render(width));
      rendered.push(...this.editorLines(width));
    }

    const questionNavigation = this.questions.length > 1 ? " · h/l or ←/→ questions" : "";
    const editorQuestionNavigation = this.questions.length > 1 ? " · ctrl+p/n questions" : "";
    const footer =
      this.focus === "options"
        ? question.multiple
          ? `1-${this.listChoices(this.currentIndex).length} or space toggle · j/k navigate · tab add notes · enter submit${questionNavigation} · esc cancel`
          : `1-${this.listChoices(this.currentIndex).length} select · j/k navigate · tab add notes · enter submit${questionNavigation} · esc cancel`
        : question.options.length > 0
          ? `enter submit answer · tab or esc clear notes${editorQuestionNavigation}`
          : `enter submit answer${editorQuestionNavigation} · esc cancel`;
    rendered.push(...new Text(this.theme.fg("dim", footer), 1, 1).render(width));
    rendered.push(
      ...new DynamicBorder((text: string) => this.theme.fg("accent", text)).render(width),
    );
    return rendered;
  }

  override invalidate(): void {
    for (const state of this.states) {
      state.list?.invalidate();
      state.editor.invalidate();
    }
  }

  handleInput(data: string): void {
    if (this.settled) return;
    const question = this.currentQuestion();

    if (this.focus === "editor") {
      if (question.options.length > 0 && matchesKey(data, Key.tab)) {
        this.clearNotesAndReturn();
        return;
      }
      if (matchesKey(data, Key.ctrl("p"))) {
        this.goToQuestion(this.currentIndex - 1);
        return;
      }
      if (matchesKey(data, Key.ctrl("n"))) {
        this.goToQuestion(this.currentIndex + 1);
        return;
      }
      if (this.keybindings.matches(data, "tui.select.cancel")) {
        if (question.options.length > 0) this.clearNotesAndReturn();
        else this.finish(undefined);
        return;
      }
      this.currentState().editor.handleInput(data);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.openNotes();
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
      this.goToQuestion(this.currentIndex - 1);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
      this.goToQuestion(this.currentIndex + 1);
      return;
    }
    if (matchesKey(data, Key.space)) {
      if (this.markChoice(this.currentIndex, this.currentState().selectedIndex)) {
        this.requestRender();
      }
      return;
    }
    if (question.multiple && matchesKey(data, Key.enter)) {
      this.submitMultipleChoice();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    this.currentState().list?.handleInput(data);
    this.requestRender();
  }

  dispose(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

function dialogOptions(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}

/** Non-TUI fallback used by Pi's RPC extension UI protocol. */
export async function showQuestionEditor(
  ctx: ExtensionContext,
  title: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  return ctx.ui.input(title, "", dialogOptions(signal));
}

/** Non-TUI fallback used by Pi's RPC extension UI protocol. */
export async function selectQuestionChoice(
  ctx: ExtensionContext,
  title: string,
  choices: QuestionChoice[],
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  if (signal?.aborted) return undefined;
  const displayed = choices.map((choice, index) => {
    const description = choice.description ? ` — ${choice.description}` : "";
    return `${index + 1}. ${choice.label}${description}`;
  });
  const selected = await ctx.ui.select(title, displayed, dialogOptions(signal));
  return selected === undefined ? undefined : displayed.indexOf(selected);
}

export async function showQuestionDialog(
  ctx: ExtensionContext,
  questions: DialogQuestion[],
  signal: AbortSignal | undefined,
): Promise<DialogAnswers | undefined> {
  if (signal?.aborted) return undefined;
  return ctx.ui.custom<DialogAnswers | undefined>(
    (tui, theme, keybindings, done) =>
      new QuestionDialog(
        tui,
        keybindings,
        theme,
        questions,
        signal,
        (message) => ctx.ui.notify(message, "warning"),
        done,
      ),
  );
}
