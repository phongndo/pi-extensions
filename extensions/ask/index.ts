import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  OTHER_CHOICE,
  selectAskChoice,
  showAskDialog,
  showAskEditor,
  type AskChoice,
} from "./ui.ts";

const MAX_CUSTOM_ANSWER_LENGTH = 4_000;
const CUSTOM_CHOICE = "Type your own answer…";

const OptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 80 }),
    description: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 240,
        description: "Brief tradeoff or consequence.",
      }),
    ),
  },
  { additionalProperties: false },
);

const QuestionSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 32,
      pattern: "^[a-z][a-z0-9_-]*$",
      description: "Short key for the returned answer, such as database.",
    }),
    question: Type.String({ minLength: 1, maxLength: 500 }),
    options: Type.Optional(
      Type.Array(OptionSchema, {
        minItems: 2,
        maxItems: 6,
        description: "Choices to present (prefer 2-4). Omit for free text.",
      }),
    ),
    multiple: Type.Optional(Type.Boolean({ description: "Allow more than one choice." })),
  },
  { additionalProperties: false },
);

export const AskParameters = Type.Object(
  {
    questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);

export type AskInput = Static<typeof AskParameters>;

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  options: AskOption[];
  multiple: boolean;
}

export type AskAnswers = Record<string, string[]>;

export type AskDetails =
  | {
      status: "answered";
      questions: AskQuestion[];
      answers: AskAnswers;
    }
  | {
      status: "cancelled";
      questions: AskQuestion[];
      answers: AskAnswers;
    }
  | {
      status: "unavailable";
      questions: AskQuestion[];
      mode: ExtensionContext["mode"];
    };

interface PromptResult {
  cancelled: boolean;
  answers: AskAnswers;
}

function replaceControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159) ? " " : character;
    })
    .join("");
}

function cleanModelText(value: string): string {
  return replaceControlCharacters(value).trim();
}

function cleanDisplayText(value: string): string {
  return replaceControlCharacters(value).replace(/\s+/g, " ").trim();
}

function preview(value: string, length = 72): string {
  const cleaned = cleanDisplayText(value);
  return cleaned.length <= length ? cleaned : `${cleaned.slice(0, length - 1)}…`;
}

export function normalizeQuestions(input: AskInput["questions"]): AskQuestion[] {
  if (input.length === 0 || input.length > 4) {
    throw new Error("ask requires one to four questions.");
  }
  const ids = new Set<string>();
  return input.map((candidate) => {
    const id = candidate.id.trim();
    const question = cleanModelText(candidate.question);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !question) {
      throw new Error("ask requires valid question ids and non-empty text.");
    }
    if (ids.has(id)) throw new Error(`ask question ids must be unique: ${id}`);
    ids.add(id);

    if (
      candidate.options !== undefined &&
      (candidate.options.length < 2 || candidate.options.length > 6)
    ) {
      throw new Error(`ask question ${id} requires two to six options.`);
    }
    const labels = new Set<string>();
    const options = (candidate.options ?? []).map((candidateOption) => {
      const label = cleanModelText(candidateOption.label);
      const key = label.toLowerCase();
      if (!label) throw new Error(`ask question ${id} has an empty option label.`);
      if (key === OTHER_CHOICE.toLowerCase()) {
        throw new Error(`ask question ${id} uses reserved option label: ${OTHER_CHOICE}.`);
      }
      if (labels.has(key)) throw new Error(`ask question ${id} has duplicate option labels.`);
      labels.add(key);
      const description = candidateOption.description
        ? cleanModelText(candidateOption.description)
        : undefined;
      return description ? { label, description } : { label };
    });

    const multiple = candidate.multiple ?? false;
    if (multiple && options.length === 0) {
      throw new Error(`ask question ${id} cannot use multiple without options.`);
    }
    return { id, question, options, multiple };
  });
}

function titleFor(question: AskQuestion, index: number, total: number): string {
  const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";
  const suffix = question.multiple ? " (select all that apply)" : "";
  return `${prefix}${question.question}${suffix}`;
}

function optionChoice(option: AskOption, marker?: string): AskChoice {
  return {
    label: marker ? `${marker} ${option.label}` : option.label,
    ...(option.description ? { description: option.description } : {}),
  };
}

async function promptForText(
  ctx: ExtensionContext,
  title: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  while (true) {
    if (signal?.aborted) return undefined;
    const answer = await showAskEditor(ctx, title, signal);
    if (answer === undefined || signal?.aborted) return undefined;
    const trimmed = answer.trim();
    if (!trimmed) {
      ctx.ui.notify("Enter an answer or press Escape to cancel.", "warning");
      continue;
    }
    if (trimmed.length > MAX_CUSTOM_ANSWER_LENGTH) {
      ctx.ui.notify(
        `Keep the answer under ${MAX_CUSTOM_ANSWER_LENGTH.toLocaleString()} characters.`,
        "warning",
      );
      continue;
    }
    return trimmed;
  }
}

async function promptSingleChoice(
  ctx: ExtensionContext,
  question: AskQuestion,
  index: number,
  total: number,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  const choices: AskChoice[] = [
    ...question.options.map((option) => optionChoice(option)),
    { label: CUSTOM_CHOICE },
  ];
  while (true) {
    const selectedIndex = await selectAskChoice(
      ctx,
      titleFor(question, index, total),
      choices,
      signal,
    );
    if (selectedIndex === undefined) return undefined;
    const option = question.options[selectedIndex];
    if (option) return [option.label];
    if (selectedIndex !== question.options.length) continue;
    const custom = await promptForText(ctx, question.question, signal);
    if (custom !== undefined) return [custom];
  }
}

async function promptMultipleChoice(
  ctx: ExtensionContext,
  question: AskQuestion,
  index: number,
  total: number,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  const selectedLabels = new Set<string>();
  let customAnswer: string | undefined;

  while (true) {
    const choices: AskChoice[] = question.options.map((option) =>
      optionChoice(option, selectedLabels.has(option.label) ? "✓" : "○"),
    );
    choices.push({
      label: customAnswer ? `✓ Custom answer — ${preview(customAnswer)}` : `○ ${CUSTOM_CHOICE}`,
    });
    const answerCount = selectedLabels.size + (customAnswer ? 1 : 0);
    choices.push({ label: answerCount > 0 ? `Done — ${answerCount} selected` : "Done" });

    const selectedIndex = await selectAskChoice(
      ctx,
      titleFor(question, index, total),
      choices,
      signal,
    );
    if (selectedIndex === undefined) return undefined;

    const customIndex = question.options.length;
    const doneIndex = customIndex + 1;
    if (selectedIndex === doneIndex) {
      if (answerCount === 0) {
        ctx.ui.notify("Select at least one answer or press Escape to cancel.", "warning");
        continue;
      }
      const ordered = question.options
        .filter((option) => selectedLabels.has(option.label))
        .map((option) => option.label);
      if (customAnswer) ordered.push(customAnswer);
      return [...new Set(ordered)];
    }

    if (selectedIndex === customIndex) {
      const custom = await promptForText(ctx, question.question, signal);
      if (custom !== undefined) customAnswer = custom;
      continue;
    }

    const option = question.options[selectedIndex];
    if (!option) continue;
    if (selectedLabels.has(option.label)) selectedLabels.delete(option.label);
    else selectedLabels.add(option.label);
  }
}

export async function promptForAnswers(
  ctx: ExtensionContext,
  questions: AskQuestion[],
  signal: AbortSignal | undefined,
): Promise<PromptResult> {
  if (ctx.mode === "tui") {
    const answers = await showAskDialog(ctx, questions, signal);
    return answers === undefined ? { cancelled: true, answers: {} } : { cancelled: false, answers };
  }

  const answers: AskAnswers = {};
  for (const [index, question] of questions.entries()) {
    let answer: string[] | undefined;
    if (question.options.length === 0) {
      const custom = await promptForText(ctx, titleFor(question, index, questions.length), signal);
      answer = custom === undefined ? undefined : [custom];
    } else if (question.multiple) {
      answer = await promptMultipleChoice(ctx, question, index, questions.length, signal);
    } else {
      answer = await promptSingleChoice(ctx, question, index, questions.length, signal);
    }

    if (answer === undefined) return { cancelled: true, answers };
    answers[question.id] = answer;
  }
  return { cancelled: false, answers };
}

function answerContent(answers: AskAnswers): string {
  return JSON.stringify(answers);
}

export default function askExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask",
    label: "ask",
    description:
      "Ask the user one to four brief, related questions and wait for answers. Use only when answers materially affect the work; batch related questions in one call instead of asking them separately. Options are optional; use two to four normally (maximum six). The UI always allows a custom answer.",
    promptSnippet: "Ask the user brief questions and wait for the answers",
    parameters: AskParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions);
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: '{"unavailable":"interactive UI required"}' }],
          details: { status: "unavailable", questions, mode: ctx.mode } satisfies AskDetails,
        };
      }

      const result = await promptForAnswers(ctx, questions, signal);
      if (result.cancelled) {
        return {
          content: [{ type: "text", text: '{"cancelled":true}' }],
          details: {
            status: "cancelled",
            questions,
            answers: result.answers,
          } satisfies AskDetails,
        };
      }

      return {
        content: [{ type: "text", text: answerContent(result.answers) }],
        details: {
          status: "answered",
          questions,
          answers: result.answers,
        } satisfies AskDetails,
      };
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const first = questions[0];
      const summary =
        questions.length === 1 && first && typeof first.question === "string"
          ? preview(first.question, 120)
          : `${questions.length} questions`;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("ask"))} ${theme.fg("muted", summary)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as AskDetails | undefined;
      if (!details) {
        const text = result.content.find((item) => item.type === "text");
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      if (details.status === "cancelled") {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      if (details.status === "unavailable") {
        return new Text(theme.fg("warning", "Interactive UI unavailable"), 0, 0);
      }

      const lines: string[] = [];
      for (const question of details.questions) {
        const values = details.answers[question.id] ?? [];
        lines.push(
          `${theme.fg("success", "✓ ")}${theme.fg("accent", question.id)}${theme.fg("muted", ": ")}${theme.fg("toolOutput", values.map((value) => cleanDisplayText(value)).join(", "))}`,
        );
        if (options.expanded) lines.push(theme.fg("dim", `  ${question.question}`));
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
