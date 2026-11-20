import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  effectiveThinking,
  loadAdvisorChoice,
  parseSpec,
  resolveModelRef,
  saveAdvisorChoice,
} from "../config.ts";
import { ADVISOR_TOOL, createAdvisorExtension, type AdvisorDetails } from "../index.ts";
import { AdvisorPicker, type AdvisorPickerOptions, type PickerResult } from "../picker.ts";
import { buildAdvisorRequest, type PromptCacheState } from "../prompt.ts";
import { fitTranscript, transcriptItems, type TranscriptItem } from "../transcript.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-advisor-"));
  dirs.push(dir);
  return join(dir, "advisor.json");
}

function model(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    provider,
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...extra,
  } as Model<Api>;
}

const usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}) {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "worker",
    usage,
    stopReason: "toolUse",
    timestamp: 1,
    ...extra,
  } as AssistantMessage;
}

test("parses specs without mistaking model-id colons for thinking levels", () => {
  assert.deepEqual(parseSpec("openai/gpt-5.5:high"), { ref: "openai/gpt-5.5", thinking: "high" });
  assert.deepEqual(parseSpec("ollama/qwen3:32b"), { ref: "ollama/qwen3:32b" });
  assert.deepEqual(parseSpec("  anthropic/claude-opus-5-5  "), {
    ref: "anthropic/claude-opus-5-5",
  });
});

test("resolves exact refs, unique bare ids, and reports ambiguity", () => {
  const a = model("openai", "gpt-5.5");
  const b = model("openrouter", "gpt-5.5");
  const c = model("anthropic", "claude-opus-5-5");
  const find = (provider: string, id: string) =>
    [a, b, c].find((m) => m.provider === provider && m.id === id);
  assert.equal(resolveModelRef("openai/gpt-5.5", find, [a, b, c]), a);
  assert.equal(resolveModelRef("claude-opus-5-5", find, [a, b, c]), c);
  assert.match(String(resolveModelRef("gpt-5.5", find, [a, b, c])), /ambiguous/);
  assert.match(String(resolveModelRef("nope/x", find, [a])), /Unknown model/);
});

test("clamps thinking to the model and defaults high", () => {
  const m = model("x", "y", { thinkingLevelMap: { xhigh: "xhigh" } });
  assert.equal(effectiveThinking(m, undefined), "high");
  assert.equal(effectiveThinking(m, "xhigh"), "xhigh");
  assert.equal(effectiveThinking(m, "off"), "off");
  assert.equal(effectiveThinking(model("x", "z", { reasoning: false }), "high"), "off");
});

const KEY = {
  up: "\x1b[A",
  down: "\x1b[B",
  enter: "\r",
  escape: "\x1b",
  shiftTab: "\x1b[Z",
  tab: "\t",
};

function picker(options: Partial<AdvisorPickerOptions> = {}) {
  initTheme("dark", false);
  // Pi registers its app bindings globally; tests register the one the picker uses.
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      "app.thinking.cycle": { defaultKeys: "shift+tab" },
    } as typeof TUI_KEYBINDINGS),
  );
  const results: (PickerResult | undefined)[] = [];
  const view = new AdvisorPicker({
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme,
    models: [
      model("openai", "gpt-6.2-sol", { thinkingLevelMap: { xhigh: "xhigh" } }),
      model("anthropic", "claude-opus-5-5"),
      model("anthropic", "claude-haiku-5-5", { reasoning: false }),
    ],
    scoped: [],
    defaultThinking: "high",
    done: (result) => results.push(result),
    ...options,
  });
  const screen = () => stripAnsi(view.render(100).join("\n"));
  return { view, results, screen };
}

test("picker opens on the current advisor, listed first and marked", () => {
  const current = model("anthropic", "claude-opus-5-5");
  const { view, results, screen } = picker({ current: { model: current, thinking: "medium" } });
  assert.match(screen(), /→ ✓ claude-opus-5-5 \[anthropic\]/);
  assert.match(screen(), /Thinking: medium/);
  view.handleInput(KEY.enter);
  assert.deepEqual(results, [{ kind: "model", model: current, thinking: "medium" }]);
});

test("picker filters by typing, cycles thinking, and offers off", () => {
  const { view, results, screen } = picker();
  assert.match(screen(), /→ ✓ off/);
  for (const char of "sol") view.handleInput(char);
  assert.match(screen(), /→ {3}gpt-6\.2-sol \[openai\]/);
  assert.match(screen(), /Thinking: high/);
  view.handleInput(KEY.shiftTab);
  assert.match(screen(), /Thinking: xhigh/);
  view.handleInput(KEY.enter);
  const chosen = results[0];
  assert.equal(chosen?.kind === "model" && chosen.model.id, "gpt-6.2-sol");
  assert.equal(chosen?.kind === "model" && chosen.thinking, "xhigh");

  const second = picker();
  for (const char of "haiku") second.view.handleInput(char);
  assert.match(second.screen(), /Thinking: not supported/);
  second.view.handleInput(KEY.shiftTab);
  second.view.handleInput(KEY.enter);
  const plain = second.results[0];
  assert.equal(plain?.kind === "model" && plain.thinking, "off");
});

test("picker selects off, cancels with escape, and toggles scope", () => {
  const off = picker({
    current: { model: model("anthropic", "claude-opus-5-5"), thinking: "high" },
  });
  off.view.handleInput(KEY.up);
  off.view.handleInput(KEY.enter);
  assert.deepEqual(off.results, [{ kind: "off" }]);

  const searched = picker({
    current: { model: model("anthropic", "claude-opus-5-5"), thinking: "high" },
    initialSearch: "gpt-6.2",
  });
  assert.match(searched.screen(), /→ {3}gpt-6\.2-sol/);

  const cancel = picker();
  cancel.view.handleInput(KEY.escape);
  assert.deepEqual(cancel.results, [undefined]);

  const scoped = picker({ scoped: [model("anthropic", "claude-opus-5-5")] });
  assert.doesNotMatch(scoped.screen(), /gpt-6\.2-sol/);
  scoped.view.handleInput(KEY.tab);
  assert.match(scoped.screen(), /gpt-6\.2-sol/);
});

test("round-trips the preference file and rejects invalid configs", async () => {
  const path = await tempConfig();
  assert.equal(await loadAdvisorChoice(path), undefined);
  await saveAdvisorChoice({ provider: "openai", model: "gpt-5.5", thinking: "high" }, path);
  assert.deepEqual(await loadAdvisorChoice(path), {
    provider: "openai",
    model: "gpt-5.5",
    thinking: "high",
  });
  await saveAdvisorChoice(undefined, path);
  assert.equal(await loadAdvisorChoice(path), undefined);
  await writeFile(path, JSON.stringify({ version: 1, advisor: { provider: "x" } }));
  await assert.rejects(loadAdvisorChoice(path), /Invalid advisor config/);
});

test("flattens messages with full tool output, labels, and no redacted thinking", () => {
  const long = "x".repeat(10_000);
  const messages: Message[] = [
    { role: "system", content: "prompt", timestamp: 0 },
    { role: "user", content: "fix the bug", timestamp: 0 },
    assistant([
      { type: "thinking", thinking: "plan it" },
      { type: "thinking", thinking: "secret", redacted: true },
      { type: "text", text: "Looking." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "read",
      content: [{ type: "text", text: long }],
      isError: false,
      timestamp: 0,
    },
  ];
  const items = transcriptItems(messages);
  assert.deepEqual(
    items.map((item) => item.tag),
    ["user", "thinking", "assistant", "tool_call", "tool_result"],
  );
  assert.equal(items[4]?.text.length, 10_000);
  assert.deepEqual(items[4]?.attrs, { name: "read", id: "c1" });
});

test("fits the transcript by shrinking old output before dropping turns", () => {
  const items: TranscriptItem[] = [
    { tag: "user", text: "original request" },
    ...Array.from({ length: 30 }, (_, index): TranscriptItem[] => [
      { tag: "tool_call", attrs: { name: "bash" }, text: `{"n":${index}}` },
      { tag: "tool_result", attrs: { name: "bash" }, text: `${index}:${"y".repeat(20_000)}` },
    ]).flat(),
  ];
  const fit = (budget: number) => {
    const result = fitTranscript(items, budget);
    return { text: result.items.join("\n\n"), truncated: result.truncated };
  };
  const whole = fitTranscript(items, 10_000_000);
  assert.equal(whole.truncated, false);
  assert.equal(whole.items.length, items.length);

  const shrunk = fit(250_000);
  assert.equal(shrunk.truncated, true);
  assert.ok(shrunk.text.length <= 250_000);
  assert.match(shrunk.text, /original request/);
  assert.match(shrunk.text, /characters omitted/);
  // The newest result stays whole.
  assert.ok(shrunk.text.includes(`29:${"y".repeat(20_000)}`));

  const dropped = fit(60_000);
  assert.ok(dropped.text.length <= 60_000);
  assert.match(dropped.text, /original request/);
  assert.match(dropped.text, /earlier items omitted/);

  const tiny = fit(5_000);
  assert.ok(tiny.text.length <= 5_000);
  assert.equal(tiny.truncated, true);
});

function requestFor(messages: Message[], previous?: PromptCacheState, cacheKey = "k") {
  return buildAdvisorRequest({
    model: model("openai", "gpt-5.5"),
    executorSystemPrompt: "EXECUTOR PROMPT",
    tools: [{ name: "read", description: "Read files\nmore detail" }],
    messages,
    cacheKey,
    ...(previous ? { previous } : {}),
  });
}

test("builds a request with the executor prompt, tools, and transcript", () => {
  const request = requestFor([{ role: "user", content: "hello", timestamp: 0 }]);
  assert.equal(request.truncated, false);
  assert.equal(request.content.length, 2);
  assert.match(request.content[0]?.text ?? "", /<executor_system_prompt>\nEXECUTOR PROMPT/);
  assert.match(request.content[0]?.text ?? "", /- read: Read files\n<\/executor_tools>$/);
  assert.equal(request.content[1]?.text, "<user>\nhello\n</user>");
});

test("repeats earlier blocks verbatim so block-boundary caches can hit", () => {
  const first: Message[] = [
    { role: "user", content: "task", timestamp: 0 },
    assistant([{ type: "toolCall", id: "a1", name: ADVISOR_TOOL, arguments: {} }]),
  ];
  const one = requestFor(first);
  const second: Message[] = [
    ...first,
    {
      role: "toolResult",
      toolCallId: "a1",
      toolName: ADVISOR_TOOL,
      content: [{ type: "text", text: "advice" }],
      isError: false,
      timestamp: 0,
    },
    assistant([{ type: "toolCall", id: "a2", name: ADVISOR_TOOL, arguments: {} }]),
  ];
  const two = requestFor(second, one.state);
  assert.equal(two.content.length, 3);
  assert.deepEqual(two.content.slice(0, 2), one.content);
  assert.match(two.content[2]?.text ?? "", /^<tool_result name="advisor"/);

  // A different session or model, or an edited history, starts a single block again.
  assert.equal(requestFor(second, one.state, "other").content.length, 2);
  const edited = [
    { role: "user", content: "changed", timestamp: 0 } as Message,
    ...second.slice(1),
  ];
  assert.equal(requestFor(edited, one.state).content.length, 2);
});

function harness(configPath: string) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  let active = ["read", "bash"];
  const pi = {
    registerTool: (tool: { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    getAllTools: () => [
      { name: "read", description: "Read a file" },
      { name: "bash", description: "Run a command" },
      { name: ADVISOR_TOOL, description: "advisor" },
    ],
  } as unknown as ExtensionAPI;
  createAdvisorExtension({ configPath })(pi);

  const advisorModel = model("anthropic", "claude-opus-5-5");
  const requests: { context: Context; options?: SimpleStreamOptions }[] = [];
  let reply: Partial<AssistantMessage> = { stopReason: "stop" };
  const notices: string[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: false,
    scopedModels: [],
    ui: { notify: (message: string) => notices.push(message) },
    getSystemPrompt: () => "EXECUTOR PROMPT",
    sessionManager: {
      buildSessionProjection: () => ({
        messages: [{ role: "user", content: "refactor auth", timestamp: 0 }],
      }),
      getSessionId: () => "session-1",
    },
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === advisorModel.provider && id === advisorModel.id ? advisorModel : undefined,
      getAvailable: () => [advisorModel],
      hasConfiguredAuth: () => true,
      streamSimple: (_model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
        requests.push({ context, options });
        const stream = createAssistantMessageEventStream();
        const final = assistant([{ type: "text", text: "Verify the token refresh path." }], {
          stopReason: "stop",
          ...reply,
        });
        queueMicrotask(() => {
          stream.push({ type: "start", partial: final });
          if (final.stopReason === "error" || final.stopReason === "aborted") {
            stream.push({ type: "error", reason: final.stopReason, error: final });
          } else {
            stream.push({ type: "text_delta", contentIndex: 0, delta: "Verify", partial: final });
            stream.push({ type: "done", reason: "stop", message: final });
          }
        });
        return stream;
      },
    },
  };
  return {
    tool: tools.get(ADVISOR_TOOL),
    command: commands.get("advisor"),
    emit: (event: string, payload: unknown) => handlers.get(event)?.(payload, ctx),
    active: () => active,
    requests,
    notices,
    ctx,
    setReply: (next: Partial<AssistantMessage>) => {
      reply = next;
    },
  };
}

test("registers advisor inactive with guidelines that name the tool", async () => {
  const h = harness(await tempConfig());
  assert.equal(h.tool.defaultActive, false);
  assert.equal(h.tool.executionMode, "sequential");
  for (const guideline of h.tool.promptGuidelines) assert.match(guideline, /advisor/);
  await h.emit("session_start", { reason: "startup" });
  assert.equal(h.active().includes(ADVISOR_TOOL), false);
});

test("/advisor saves the choice, activates the tool, and off deactivates it", async () => {
  const path = await tempConfig();
  const h = harness(path);
  await h.emit("session_start", { reason: "startup" });
  await h.command.handler("anthropic/claude-opus-5-5:high", h.ctx);
  assert.ok(h.active().includes(ADVISOR_TOOL));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    advisor: { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" },
  });

  const fresh = harness(path);
  await fresh.emit("session_start", { reason: "startup" });
  assert.ok(fresh.active().includes(ADVISOR_TOOL));

  await h.command.handler("off", h.ctx);
  assert.equal(h.active().includes(ADVISOR_TOOL), false);
  assert.equal(await loadAdvisorChoice(path), undefined);

  await h.command.handler("missing/model", h.ctx);
  assert.match(h.notices.at(-1) ?? "", /Unknown model/);
});

test("execute forwards the transcript, including an unpersisted advisor call", async () => {
  const h = harness(await tempConfig());
  await h.emit("session_start", { reason: "startup" });
  await h.command.handler("anthropic/claude-opus-5-5:high", h.ctx);
  await h.emit("message_end", {
    message: assistant([{ type: "toolCall", id: "adv-1", name: ADVISOR_TOOL, arguments: {} }]),
  });

  const updates: unknown[] = [];
  const result = await h.tool.execute(
    "adv-1",
    {},
    undefined,
    (u: unknown) => updates.push(u),
    h.ctx,
  );

  assert.equal(result.content[0].text, "Verify the token refresh path.");
  const details = result.details as AdvisorDetails;
  assert.equal(details.status, "done");
  assert.equal(details.model, "anthropic/claude-opus-5-5:high");
  assert.ok(updates.length >= 1);

  const request = h.requests[0];
  assert.ok(request);
  assert.match(String(request.context.systemPrompt), /You are the advisor/);
  const content = request.context.messages[0]?.content;
  const text = Array.isArray(content)
    ? content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
    : "";
  assert.match(text, /EXECUTOR PROMPT/);
  assert.match(text, /refactor auth/);
  assert.match(text, /<tool_call name="advisor" id="adv-1">/);
  assert.match(text, /- read: Read a file/);
  assert.equal(request.options?.reasoning, "high");
  assert.match(String(request.options?.sessionId), /^advisor-[0-9a-f]{32}$/);
});

test("execute surfaces provider errors and missing configuration", async () => {
  const h = harness(await tempConfig());
  await h.emit("session_start", { reason: "startup" });
  await assert.rejects(h.tool.execute("a", {}, undefined, undefined, h.ctx), /No advisor model/);

  await h.command.handler("anthropic/claude-opus-5-5", h.ctx);
  h.setReply({ stopReason: "error", errorMessage: "overloaded" });
  await assert.rejects(h.tool.execute("a", {}, undefined, undefined, h.ctx), /overloaded/);
});
