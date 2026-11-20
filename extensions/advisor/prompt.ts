import type { Api, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { fitTranscript, shrinkText, transcriptItems } from "./transcript.ts";

export const ADVISOR_SYSTEM_PROMPT = `You are the advisor: a senior reviewer that an AI coding agent (the executor) consults mid-task. You receive the executor's system prompt, its tools, and its full transcript, which ends with the executor's call to you. You cannot call tools, read files, or talk to the user. Your reply is returned to the executor as the result of its \`advisor\` tool call.

The input arrives as one message: <executor_system_prompt>, <executor_tools>, then transcript items in order (<user>, <thinking>, <assistant>, <tool_call>, <tool_result>). Respond with your advice for the moment the transcript ends.

How to advise:
- Work out what the user actually asked for and what the executor is about to do, and judge whether that will satisfy the request.
- Look for wrong assumptions, misread tool output, unverified claims, missed requirements, scope creep, risky or irreversible actions, and simpler approaches.
- Be concrete: name the files, commands, checks, and next step. Where something is uncertain, say what evidence would settle it.
- If the executor is about to declare the task done, check the deliverable against the request and say what is missing or unverified.
- If the approach is sound, say so briefly and add only what improves it. Do not invent problems.
- Earlier \`advisor\` tool results in the transcript are your own previous advice. Build on them rather than repeating them, and note where the executor ignored or disproved them.
- Do not do the task yourself. Small code snippets are fine when they are the clearest way to make a point.

Be direct and brief: usually under 400 words, as a short prioritized list.`;

const CHARS_PER_TOKEN = 3;
const OUTPUT_RESERVE_MAX = 32_000;
const SYSTEM_PROMPT_KEEP = 30_000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const TRUNCATED_NOTE =
  "[Parts of the transcript were shortened to fit your context window; omissions are marked.]";

export interface ToolSummary {
  name: string;
  description: string;
}

/**
 * What the previous request in this session sent, so the next one can repeat it block for
 * block. Providers that cache at block boundaries (Anthropic) then read the earlier prefix.
 */
export interface PromptCacheState {
  key: string;
  head: string;
  items: readonly string[];
  /** Exclusive item index where each transcript block ends. */
  blockEnds: readonly number[];
}

/** Characters of transcript the advisor model can take beside its prompt and output. */
export function transcriptBudget(model: Model<Api>, fixedChars: number): number {
  const window = model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
  const reserve = Math.min(model.maxTokens > 0 ? model.maxTokens : 16_000, OUTPUT_RESERVE_MAX);
  const usableTokens = Math.max(8_000, window - reserve - 2_000);
  return Math.max(20_000, usableTokens * CHARS_PER_TOKEN - fixedChars);
}

function toolLines(tools: readonly ToolSummary[]): string {
  return tools
    .map((tool) => {
      const line = tool.description.split("\n")[0]?.trim() ?? "";
      return `- ${tool.name}: ${line.length > 240 ? `${line.slice(0, 239)}…` : line}`;
    })
    .join("\n");
}

/** Extend the previous block layout when this transcript strictly continues it. */
function blockEnds(
  previous: PromptCacheState | undefined,
  key: string,
  head: string,
  items: readonly string[],
): number[] {
  const continues =
    previous !== undefined &&
    previous.key === key &&
    previous.head === head &&
    previous.items.length <= items.length &&
    previous.items.every((item, index) => item === items[index]);
  if (!continues) return items.length ? [items.length] : [];
  const ends = [...previous.blockEnds];
  if (items.length > (ends.at(-1) ?? 0)) ends.push(items.length);
  return ends;
}

/**
 * The advisor's single user message: static context first, then the append-only transcript
 * split into one block per earlier advisor call, so each request extends the last one.
 */
export function buildAdvisorRequest(input: {
  model: Model<Api>;
  executorSystemPrompt: string;
  tools: readonly ToolSummary[];
  messages: readonly Message[];
  cacheKey: string;
  previous?: PromptCacheState;
}): {
  content: TextContent[];
  truncated: boolean;
  transcriptChars: number;
  state: PromptCacheState | undefined;
} {
  const head = [
    "<executor_system_prompt>",
    shrinkText(input.executorSystemPrompt.trim(), SYSTEM_PROMPT_KEEP),
    "</executor_system_prompt>",
    "",
    "<executor_tools>",
    toolLines(input.tools),
    "</executor_tools>",
  ].join("\n");

  const fixed = ADVISOR_SYSTEM_PROMPT.length + head.length + TRUNCATED_NOTE.length + 16;
  const { items, truncated } = fitTranscript(
    transcriptItems(input.messages),
    transcriptBudget(input.model, fixed),
  );
  // A shortened transcript changes from call to call, so there is no stable prefix to extend.
  const ends = truncated ? [items.length] : blockEnds(input.previous, input.cacheKey, head, items);

  const content: TextContent[] = [{ type: "text", text: head }];
  let start = 0;
  for (const end of ends) {
    content.push({ type: "text", text: items.slice(start, end).join("\n\n") });
    start = end;
  }
  if (truncated) content.push({ type: "text", text: TRUNCATED_NOTE });

  return {
    content,
    truncated,
    transcriptChars: items.reduce((total, item) => total + item.length, 0),
    state: truncated ? undefined : { key: input.cacheKey, head, items, blockEnds: ends },
  };
}
