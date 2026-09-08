export const OTHER_CHOICE = "None of the above";
export const MAX_CUSTOM_ANSWER_LENGTH = 4_000;

export type SubmittedAnswer = [string, ...string[]];
export type CustomAnswer = { kind: "answer" | "note"; text: string };

/** Shared submission policy; adapters retain their distinct note/custom-answer UX. */
export function choiceAnswer(
  options: readonly { label: string }[],
  selected: ReadonlySet<string>,
  custom?: CustomAnswer,
): SubmittedAnswer | undefined {
  const text = custom?.text.trim();
  if (text && text.length > MAX_CUSTOM_ANSWER_LENGTH)
    throw new Error(`Keep the answer under ${MAX_CUSTOM_ANSWER_LENGTH} characters.`);
  const values = options
    .filter((option) => selected.has(option.label))
    .map((option) => option.label);
  if (selected.has(OTHER_CHOICE) && !text) values.push(OTHER_CHOICE);
  if (text) values.push(custom?.kind === "note" ? `user_note: ${text}` : text);
  const unique = [...new Set(values)];
  return unique.length ? (unique as SubmittedAnswer) : undefined;
}
