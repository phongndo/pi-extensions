import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type AssistantMessage, type ToolCall, type Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type RegisteredCommand,
  type ToolDefinition,
  type SessionBeforeCompactEvent,
  type CompactionResult,
  type CompactOptions,
} from "@earendil-works/pi-coding-agent";
import { createContextExtension, type ContextOptions } from "../index.ts";

export const checkpoint = {
  goal: "Implement the requested fix",
  constraints: "Do not deploy",
  progress: "First fix failed; narrow the retry boundary",
  nextSteps: "Test the second fix and report",
};
export const model: Model<"openai-responses"> = {
  id: "gpt-4.1",
  name: "Offline test model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
};

export function assistant(
  content: AssistantMessage["content"],
  inputTokens = 100,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: inputTokens,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}
export function user(sm: SessionManager, text = "Fix the bug without deploying") {
  return sm.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}
export function toolCall(sm: SessionManager, id = "checkpoint-call", siblings: ToolCall[] = []) {
  return sm.appendMessage(
    assistant([
      { type: "toolCall", id, name: "notes", arguments: { action: "checkpoint", checkpoint } },
      ...siblings,
    ]),
  );
}
export function receipt(sm: SessionManager, id = "checkpoint-call", isError = false) {
  return sm.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "notes",
    content: [{ type: "text", text: "Saved" }],
    isError,
    timestamp: Date.now(),
  });
}

export async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-context-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
export async function harness(
  t: TestContext,
  options: ContextOptions = {},
  existing?: SessionManager,
) {
  const root = await temporary(t);
  const sm = existing ?? SessionManager.create(root, join(root, "sessions"));
  const path = options.statePath ?? join(root, "context.json");
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const notifications: string[] = [];
  const statuses = new Map<string, string | undefined>();
  const sent: unknown[] = [];
  const compactions: CompactOptions[] = [];
  const controls = {
    tokens: 100,
    pending: false,
    idle: true,
    tools: ["recall", "notes", "read", "bash"],
  };
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    model,
    sessionManager: sm,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    },
    getContextUsage: () => ({
      tokens: controls.tokens,
      contextWindow: model.contextWindow,
      percent: (controls.tokens / model.contextWindow) * 100,
    }),
    getSystemPrompt: () => "System rules",
    isIdle: () => controls.idle,
    hasPendingMessages: () => controls.pending,
    compact: (options: CompactOptions) => compactions.push(options),
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
    getActiveTools: () => controls.tools,
    appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
    sendMessage: (...args: unknown[]) => sent.push(args),
  } as unknown as ExtensionAPI;
  createContextExtension({ pollMs: 0, ...options, statePath: path })(api);
  async function emit(name: string, event: object = {}) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? [])
      result = await handler({ type: name, ...event }, ctx);
    return result;
  }
  t.after(async () => {
    await emit("session_shutdown");
  });
  await emit("session_start");
  const execute = (
    name: string,
    params: Record<string, unknown>,
    id = "checkpoint-call",
    signal = new AbortController().signal,
  ) => tools.get(name)!.execute(id, params, signal, undefined, ctx);
  async function saveCheckpoint(reset = false, id = "checkpoint-call") {
    toolCall(sm, id);
    const result = await execute("notes", { action: "checkpoint", checkpoint, reset }, id);
    receipt(sm, id);
    return result;
  }
  async function beforeCompact(extra: Partial<SessionBeforeCompactEvent> = {}) {
    const branchEntries = sm.getBranch();
    const preparation: SessionBeforeCompactEvent["preparation"] = {
      firstKeptEntryId: branchEntries[0]?.id ?? "empty",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 90_000,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 16 },
    };
    return (await emit("session_before_compact", {
      branchEntries,
      preparation,
      signal: new AbortController().signal,
      ...extra,
    })) as { cancel?: boolean; compaction?: CompactionResult } | undefined;
  }
  const command = (args: string) =>
    commands.get("context")!.handler(args, ctx as Parameters<RegisteredCommand["handler"]>[1]);
  return {
    root,
    path,
    sm,
    ctx,
    controls,
    tools,
    commands,
    notifications,
    statuses,
    sent,
    compactions,
    emit,
    execute,
    saveCheckpoint,
    beforeCompact,
    command,
  };
}
