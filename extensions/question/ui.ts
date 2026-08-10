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

const NUMBER_SHORTCUTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MIN_OPTION_COLUMN_WIDTH = 32;
const MAX_OPTION_COLUMN_WIDTH = 90;
export const OTHER_CHOICE = "None of the above";
const OTHER_DESCRIPTION = "Optionally, add details in notes (tab).";
const MAX_CUSTOM_ANSWER_LENGTH = 4_000;

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
  list?: NumberedSelectList;
  selectedIndex: number;
  selectedLabels: Set<string>;
  singleAnswer?: string;
  customAnswer?: string;
  textAnswer?: string;
  committed: boolean;
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

  constructor(items: SelectItem[], maxVisible: number, theme: SelectListTheme) {
    const count = Math.min(items.length, NUMBER_SHORTCUTS.length);
    const numberedItems = items.map((item, index) =>
      index < count ? { ...item, label: `${index + 1}. ${item.label}` } : item,
    );
    super(numberedItems, maxVisible, theme, {
      minPrimaryColumnWidth: MIN_OPTION_COLUMN_WIDTH,
      maxPrimaryColumnWidth: MAX_OPTION_COLUMN_WIDTH,
    });
    this.shortcutItems = numberedItems.slice(0, count);
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
  private focus: Focus;
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
    this.focus = questions[0]?.options.length ? "options" : "editor";

    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: selectTheme(theme),
    };
    this.states = questions.map((_question, index) => {
      const editor = new Editor(tui, editorTheme, { paddingX: 1 });
      editor.onSubmit = (value) => this.submitEditor(index, value);
      return {
        editor,
        selectedIndex: 0,
        selectedLabels: new Set<string>(),
        committed: false,
      };
    });
    for (const index of this.questions.keys()) this.rebuildList(index);

    this.onAbort = () => this.finish(undefined);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    this.syncEditorFocus();
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
    const question = this.questions[index]!;
    const state = this.states[index]!;
    if (!state.committed) return false;
    if (question.options.length === 0) return Boolean(state.textAnswer);
    return question.multiple ? state.selectedLabels.size > 0 : Boolean(state.singleAnswer);
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
      const selected = question.multiple
        ? state.selectedLabels.has(option.label)
        : state.singleAnswer === option.label;
      return {
        label: `${option.label}${selected ? "  ✓" : ""}`,
        ...(option.description ? { description: option.description } : {}),
      };
    });
    const otherSelected = question.multiple
      ? state.selectedLabels.has(OTHER_CHOICE)
      : state.singleAnswer === OTHER_CHOICE;
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
    const question = this.questions[index]!;
    const state = this.states[index]!;
    const label = this.optionLabel(index, selectedIndex);
    if (!label) return false;

    state.selectedIndex = selectedIndex;
    if (question.multiple) {
      if (label === OTHER_CHOICE) {
        state.selectedLabels.clear();
        state.selectedLabels.add(label);
      } else {
        state.selectedLabels.delete(OTHER_CHOICE);
        if (state.selectedLabels.has(label)) state.selectedLabels.delete(label);
        else state.selectedLabels.add(label);
      }
    } else {
      state.singleAnswer = label;
    }
    state.committed = false;
    this.rebuildList(index);
    return true;
  }

  private selectChoice(index: number, selectedIndex: number): void {
    if (index !== this.currentIndex || !this.markChoice(index, selectedIndex)) return;
    const question = this.questions[index]!;
    const state = this.states[index]!;
    if (question.multiple) {
      this.requestRender();
      return;
    }
    state.committed = true;
    this.advanceOrFinish();
  }

  private openNotes(): void {
    const question = this.currentQuestion();
    const state = this.currentState();
    if (question.options.length === 0) return;

    if (!question.multiple || state.selectedLabels.size === 0) {
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
    state.committed = false;
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

    const question = this.questions[index]!;
    const state = this.states[index]!;
    if (question.options.length === 0) {
      if (!answer) {
        this.notify("Enter an answer or press Escape to cancel.");
        return;
      }
      state.textAnswer = answer;
      state.editor.setText(answer);
      state.committed = true;
      this.advanceOrFinish();
      return;
    }

    if (question.multiple && state.selectedLabels.size === 0) {
      this.markChoice(index, state.selectedIndex);
    } else if (!question.multiple && !state.singleAnswer) {
      this.markChoice(index, state.selectedIndex);
    }
    if (answer) state.customAnswer = answer;
    else delete state.customAnswer;
    state.committed = true;
    this.advanceOrFinish();
  }

  private submitMultipleChoice(): void {
    const state = this.currentState();
    if (state.selectedLabels.size === 0) this.markChoice(this.currentIndex, state.selectedIndex);
    if (state.selectedLabels.size === 0) {
      this.notify("Select at least one answer before submitting.");
      return;
    }
    state.committed = true;
    this.advanceOrFinish();
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
    this.focus = this.currentQuestion().options.length > 0 ? "options" : "editor";
    this.syncEditorFocus();
    this.requestRender();
  }

  private collectAnswers(): DialogAnswers {
    const answers: DialogAnswers = {};
    for (const [index, question] of this.questions.entries()) {
      const state = this.states[index]!;
      if (question.options.length === 0) {
        answers[question.id] = [state.textAnswer!];
        continue;
      }

      const values = question.multiple
        ? question.options
            .filter((option) => state.selectedLabels.has(option.label))
            .map((option) => option.label)
        : state.singleAnswer === OTHER_CHOICE && state.customAnswer
          ? []
          : [state.singleAnswer!];
      if (question.multiple && state.selectedLabels.has(OTHER_CHOICE) && !state.customAnswer) {
        values.push(OTHER_CHOICE);
      }
      if (state.customAnswer) values.push(`user_note: ${state.customAnswer}`);
      answers[question.id] = [...new Set(values)];
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
    if (this.focus === "editor") rendered.push(...this.editorLines(width));

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
