import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
  OTHER_CHOICE,
  selectQuestionChoice,
  showQuestionDialog,
  showQuestionEditor,
  type QuestionChoice,
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

export const QuestionParameters = Type.Object(
  {
    questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);

export type QuestionInput = Static<typeof QuestionParameters>;

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  question: string;
  options: QuestionOption[];
  multiple: boolean;
}

export type QuestionAnswers = Record<string, string[]>;

export type QuestionDetails =
  | {
      status: "answered";
      questions: Question[];
      answers: QuestionAnswers;
    }
  | {
      status: "cancelled";
      questions: Question[];
      answers: QuestionAnswers;
    }
  | {
      status: "unavailable";
      questions: Question[];
      mode: ExtensionContext["mode"];
    };

interface PromptResult {
  cancelled: boolean;
  answers: QuestionAnswers;
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

export function normalizeQuestions(input: QuestionInput["questions"]): Question[] {
  if (input.length === 0 || input.length > 4) {
    throw new Error("question requires one to four questions.");
  }
  const ids = new Set<string>();
  return input.map((candidate) => {
    const id = candidate.id.trim();
    const question = cleanModelText(candidate.question);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || !question) {
      throw new Error("question requires valid question ids and non-empty text.");
    }
    if (ids.has(id)) throw new Error(`question ids must be unique: ${id}`);
    ids.add(id);

    if (
      candidate.options !== undefined &&
      (candidate.options.length < 2 || candidate.options.length > 6)
    ) {
      throw new Error(`question ${id} requires two to six options.`);
    }
    const labels = new Set<string>();
    const options = (candidate.options ?? []).map((candidateOption) => {
      const label = cleanModelText(candidateOption.label);
      const key = label.toLowerCase();
      if (!label) throw new Error(`question ${id} has an empty option label.`);
      if (key === OTHER_CHOICE.toLowerCase()) {
        throw new Error(`question ${id} uses reserved option label: ${OTHER_CHOICE}.`);
      }
      if (labels.has(key)) throw new Error(`question ${id} has duplicate option labels.`);
      labels.add(key);
      const description = candidateOption.description
        ? cleanModelText(candidateOption.description)
        : undefined;
      return description ? { label, description } : { label };
    });

    const multiple = candidate.multiple ?? false;
    if (multiple && options.length === 0) {
      throw new Error(`question ${id} cannot use multiple without options.`);
    }
    return { id, question, options, multiple };
  });
}

function titleFor(question: Question, index: number, total: number): string {
  const prefix = total > 1 ? `[${index + 1}/${total}] ` : "";
  const suffix = question.multiple ? " (select all that apply)" : "";
  return `${prefix}${question.question}${suffix}`;
}

function optionChoice(option: QuestionOption, marker?: string): QuestionChoice {
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
    const answer = await showQuestionEditor(ctx, title, signal);
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
  question: Question,
  index: number,
  total: number,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  const choices: QuestionChoice[] = [
    ...question.options.map((option) => optionChoice(option)),
    { label: CUSTOM_CHOICE },
  ];
  while (true) {
    const selectedIndex = await selectQuestionChoice(
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
  question: Question,
  index: number,
  total: number,
  signal: AbortSignal | undefined,
): Promise<string[] | undefined> {
  const selectedLabels = new Set<string>();
  let customAnswer: string | undefined;

  while (true) {
    const choices: QuestionChoice[] = question.options.map((option) =>
      optionChoice(option, selectedLabels.has(option.label) ? "✓" : "○"),
    );
    choices.push({
      label: customAnswer ? `✓ Custom answer — ${preview(customAnswer)}` : `○ ${CUSTOM_CHOICE}`,
    });
    const answerCount = selectedLabels.size + (customAnswer ? 1 : 0);
    choices.push({ label: answerCount > 0 ? `Done — ${answerCount} selected` : "Done" });

    const selectedIndex = await selectQuestionChoice(
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
  questions: Question[],
  signal: AbortSignal | undefined,
): Promise<PromptResult> {
  if (ctx.mode === "tui") {
    const answers = await showQuestionDialog(ctx, questions, signal);
    return answers === undefined ? { cancelled: true, answers: {} } : { cancelled: false, answers };
  }

  const answers: QuestionAnswers = {};
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

function answerContent(answers: QuestionAnswers): string {
  return JSON.stringify(answers);
}

export default function questionExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "question",
    label: "question",
    description:
      "Ask the user one to four brief, related questions and wait for answers. Supports free-text, single-choice, and multiple-choice questions; batch related questions in one call. Use two to four options normally (maximum six). The UI always allows a custom answer.",
    promptSnippet: "Ask the user brief clarifying questions and wait for the answers",
    promptGuidelines: [
      "Use the question tool proactively whenever you need clarification about the user's intent, scope, preferences, constraints, or tradeoffs; prefer one brief question over guessing at a consequential assumption. Do not use question for information discoverable with available tools or for trivial, low-impact choices. Batch related questions in one call.",
    ],
    parameters: QuestionParameters,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params.questions);
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: '{"unavailable":"interactive UI required"}' }],
          details: { status: "unavailable", questions, mode: ctx.mode } satisfies QuestionDetails,
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
          } satisfies QuestionDetails,
        };
      }

      return {
        content: [{ type: "text", text: answerContent(result.answers) }],
        details: {
          status: "answered",
          questions,
          answers: result.answers,
        } satisfies QuestionDetails,
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
        `${theme.fg("toolTitle", theme.bold("question"))} ${theme.fg("muted", summary)}`,
        0,
        0,
      );
    },

    renderResult(result, options, theme) {
      const details = result.details as QuestionDetails | undefined;
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
