/** Ignore presentation-only Markdown emphasis/code markers, not wording or identifiers. */
export function scoreAnswer(patterns: readonly RegExp[], answer: string): boolean[] {
  const plain = answer.replace(/[*`]/g, "");
  return patterns.map((pattern) => pattern.test(plain));
}
