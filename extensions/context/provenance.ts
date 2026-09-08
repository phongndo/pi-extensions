import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isMemoryTool } from "./model.ts";
type AgentMessage = ContextEvent["messages"][number];

function key(message: AgentMessage): string | undefined {
  if (message.role === "user") return `user:${message.timestamp}`;
  if (message.role === "toolResult" && !isMemoryTool(message.toolName))
    return `tool:${message.timestamp}:${message.toolCallId}`;
  return undefined;
}

/** Presentation only. Never edit persisted entries or assistant/provider reasoning blocks. */
export function withEvidenceIds(
  messages: AgentMessage[],
  branch: readonly SessionEntry[],
): AgentMessage[] {
  const candidates = new Map<string, { id: string; message: AgentMessage }[]>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const identity = key(entry.message);
    if (identity)
      candidates.set(identity, [
        ...(candidates.get(identity) ?? []),
        { id: entry.id, message: entry.message },
      ]);
  }
  return messages.map((message) => {
    const identity = key(message);
    if (!identity) return message;
    // Competing extensions may transform messages. Only mark an unambiguous exact source.
    const matches = (candidates.get(identity) ?? []).filter(
      (item) => JSON.stringify(item.message) === JSON.stringify(message),
    );
    if (matches.length !== 1) return message;
    if (message.role !== "user" && message.role !== "toolResult") return message;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    if (!content.some((block) => block.type === "text" && block.text.trim())) return message;
    return {
      ...message,
      content: [
        ...content,
        {
          type: "text" as const,
          text: `[evidence:${matches[0]!.id}]`,
        },
      ],
    };
  });
}
