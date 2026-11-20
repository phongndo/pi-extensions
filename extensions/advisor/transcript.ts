import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** One labelled block of the executor's transcript, in the order the executor saw it. */
export interface TranscriptItem {
  tag: "user" | "assistant" | "thinking" | "tool_call" | "tool_result";
  attrs?: Record<string, string>;
  text: string;
}

/** Tool results and thinking are shrunk to this much head and tail before anything is dropped. */
const SHRINK_KEEP = 1_500;
/** The newest items stay whole until every older item has been shrunk or dropped. */
const PROTECTED_TAIL = 12;

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : `[image: ${block.mimeType}]`))
    .filter(Boolean)
    .join("\n");
}

/**
 * Flatten LLM messages into labelled text. System messages are skipped: the caller sends the
 * current system prompt and tools once instead of every mid-conversation patch.
 */
export function transcriptItems(messages: readonly Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message.content).trim();
      if (text) items.push({ tag: "user", text });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "thinking") {
          if (!block.redacted && block.thinking.trim()) {
            items.push({ tag: "thinking", text: block.thinking.trim() });
          }
        } else if (block.type === "text") {
          if (block.text.trim()) items.push({ tag: "assistant", text: block.text.trim() });
        } else if (block.type === "toolCall") {
          items.push({
            tag: "tool_call",
            attrs: { name: block.name, id: block.id },
            text: block.argumentsError ?? JSON.stringify(block.arguments),
          });
        }
      }
      if (message.stopReason === "error" && message.errorMessage) {
        items.push({ tag: "assistant", attrs: { error: "true" }, text: message.errorMessage });
      }
    } else if (message.role === "toolResult") {
      items.push({
        tag: "tool_result",
        attrs: {
          name: message.toolName,
          id: message.toolCallId,
          ...(message.isError ? { error: "true" } : {}),
        },
        text: textOf(message.content),
      });
    }
  }
  return items;
}

export function renderItem(item: TranscriptItem): string {
  const attrs = Object.entries(item.attrs ?? {})
    .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
    .join("");
  return `<${item.tag}${attrs}>\n${item.text}\n</${item.tag}>`;
}

/** Keep the head and tail of long text, marking what was cut. */
export function shrinkText(text: string, keep: number): string {
  if (text.length <= keep * 2 + 64) return text;
  const omitted = text.length - keep * 2;
  return `${text.slice(0, keep)}\n[… ${omitted.toLocaleString("en-US")} characters omitted …]\n${text.slice(-keep)}`;
}

function size(items: readonly TranscriptItem[]): number {
  return items.reduce((total, item) => total + renderItem(item).length + 2, 0);
}

/**
 * Fit the transcript into `budget` characters, losing the least useful context first:
 * shrink old tool output and thinking, drop old turns (keeping the first user message),
 * shrink recent output, and finally keep only the newest text. Returns rendered items.
 */
export function fitTranscript(
  input: readonly TranscriptItem[],
  budget: number,
): { items: string[]; truncated: boolean } {
  let items = input.map((item) => ({ ...item }));
  const done = (truncated: boolean) => ({
    items: items.map(renderItem),
    truncated,
  });
  if (size(items) <= budget) return done(false);

  const shrinkable = (item: TranscriptItem) =>
    item.tag === "tool_result" || item.tag === "thinking" || item.tag === "tool_call";
  const shrinkRange = (end: number) => {
    for (let index = 0; index < end && size(items) > budget; index++) {
      const item = items[index];
      if (item && shrinkable(item)) item.text = shrinkText(item.text, SHRINK_KEEP);
    }
  };

  const tailStart = Math.max(0, items.length - PROTECTED_TAIL);
  shrinkRange(tailStart);
  if (size(items) <= budget) return done(true);

  const firstUser = items.findIndex((item) => item.tag === "user");
  const keepHead = firstUser >= 0 && firstUser < tailStart ? firstUser + 1 : 0;
  let dropEnd = keepHead;
  const head = items.slice(0, keepHead);
  const tail = items.slice(tailStart);
  let middle = items.slice(keepHead, tailStart);
  while (middle.length && size([...head, ...middle, ...tail]) > budget) {
    middle = middle.slice(1);
    dropEnd++;
  }
  const dropped = dropEnd - keepHead;
  if (dropped > 0) {
    items = [
      ...head,
      { tag: "user", attrs: { omitted: "true" }, text: `[${dropped} earlier items omitted]` },
      ...middle,
      ...tail,
    ];
  }
  if (size(items) <= budget) return done(true);

  shrinkRange(items.length);
  if (size(items) <= budget) return done(true);

  const text = items.map(renderItem).join("\n\n");
  const marker = "[… earlier transcript omitted …]\n";
  return { items: [marker + text.slice(-(budget - marker.length))], truncated: true };
}
