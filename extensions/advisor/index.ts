import { createHash } from "node:crypto";
import {
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { setFooterStatus } from "../../src/footer-status.ts";
import {
  isRequestSpeedPreference,
  REQUEST_SPEED,
  REQUEST_SPEED_LABELS,
  REQUEST_SPEED_PREFERENCES,
  REQUEST_SPEED_SUPPORT,
  type RequestSpeedControl,
  type RequestSpeedOptions,
  type RequestSpeedReport,
  type RequestSpeedSupportLookup,
} from "../../src/request-speed.ts";
import {
  ADVISOR_CONFIG_PATH,
  DEFAULT_THINKING,
  effectiveThinking,
  formatChoice,
  loadAdvisorChoice,
  modelRef,
  parseSpec,
  resolveModelRef,
  saveAdvisorChoice,
  type AdvisorChoice,
} from "./config.ts";
import type { PickerResult } from "./picker.ts";
import type { PromptCacheState } from "./prompt.ts";

export const ADVISOR_TOOL = "advisor";
const STATUS_KEY = "advisor";
const COLLAPSED_LINES = 12;
const UPDATE_INTERVAL_MS = 100;

export interface AdvisorDetails {
  status: "running" | "done";
  model: string;
  usage?: Usage;
  durationMs?: number;
  truncated?: boolean;
  transcriptChars?: number;
  stopReason?: string;
  speed?: RequestSpeedReport;
}

export interface AdvisorExtensionOptions {
  configPath?: string;
}

type Registry = ExtensionContext["modelRegistry"];

function hasToolCall(messages: readonly Message[], toolCallId: string): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((block) => block.type === "toolCall" && block.id === toolCallId),
  );
}

function formatTokens(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k` : String(count);
}

function formatSpeed(report: RequestSpeedReport): string {
  const label = REQUEST_SPEED_LABELS[report.requested];
  const fallback = report.fellBackTo ? ` → ${REQUEST_SPEED_LABELS[report.fellBackTo]}` : "";
  const adjusted =
    report.preferred === report.requested
      ? ""
      : ` (${REQUEST_SPEED_LABELS[report.preferred]} not requested)`;
  const reported =
    report.reportedTier && report.reportedTier !== "unknown"
      ? `, provider reported ${report.reportedTier}`
      : "";
  return `speed: ${label}${fallback}${adjusted}${reported}`;
}

function formatMeta(details: AdvisorDetails): string {
  const parts = [details.model];
  if (details.speed) parts.push(formatSpeed(details.speed));
  if (details.usage) {
    const input = details.usage.input + details.usage.cacheRead + details.usage.cacheWrite;
    parts.push(`${formatTokens(input)} in`, `${formatTokens(details.usage.output)} out`);
    if (details.usage.cost.total > 0) parts.push(`$${details.usage.cost.total.toFixed(3)}`);
  }
  if (details.durationMs !== undefined) parts.push(`${(details.durationMs / 1000).toFixed(1)}s`);
  if (details.truncated) parts.push("transcript shortened");
  return parts.join(" · ");
}

/** Factory seam for tests; the default export uses the global preference file. */
export function createAdvisorExtension(
  options: AdvisorExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const configPath = options.configPath ?? ADVISOR_CONFIG_PATH;

  return (pi) => {
    let choice: AdvisorChoice | undefined;
    let registry: Registry | undefined;
    let lastAssistant: AssistantMessage | undefined;
    let promptCache: PromptCacheState | undefined;
    let lastSpeed: RequestSpeedReport | undefined;

    const status = () => {
      if (!choice) return "Advisor off";
      const speed = REQUEST_SPEED_LABELS[choice.speed ?? "inherit"];
      return `Advisor: ${formatChoice(choice)} · speed: ${speed}${lastSpeed ? `\nLast advisor call: ${formatSpeed(lastSpeed)}` : ""}`;
    };

    const setToolActive = (active: boolean) => {
      const tools = pi.getActiveTools();
      if (tools.includes(ADVISOR_TOOL) === active) return;
      pi.setActiveTools(
        active ? [...tools, ADVISOR_TOOL] : tools.filter((name) => name !== ADVISOR_TOOL),
      );
    };

    const showFooter = (ctx: ExtensionContext) => {
      try {
        // Pi's footer style: the value in parentheses, like "(sub)" and "(auto)".
        const thinking = choice?.thinking ?? DEFAULT_THINKING;
        const speed = choice?.speed;
        const labels = choice ? [choice.model] : [];
        if (thinking !== "off") labels.push(thinking);
        if (speed && speed !== "inherit") labels.push(speed);
        setFooterStatus(ctx, STATUS_KEY, choice ? `advisor (${labels.join(" • ")})` : undefined);
      } catch {
        // A stale UI must not break configuration.
      }
    };

    const apply = async (ctx: ExtensionCommandContext, next: AdvisorChoice | undefined) => {
      try {
        await saveAdvisorChoice(next, configPath);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      choice = next;
      lastSpeed = undefined;
      setToolActive(choice !== undefined);
      showFooter(ctx);
      ctx.ui.notify(status(), "info");
    };

    const candidates = (ctx: {
      modelRegistry: Registry;
      scopedModels: ExtensionContext["scopedModels"];
    }) =>
      ctx.scopedModels.length > 0
        ? ctx.scopedModels.map((scoped) => scoped.model)
        : ctx.modelRegistry.getAvailable();

    const toChoice = (
      ctx: ExtensionCommandContext,
      model: Model<Api>,
      thinking: AdvisorChoice["thinking"],
      speed = choice?.speed,
    ): AdvisorChoice | string =>
      ctx.modelRegistry.hasConfiguredAuth(model)
        ? {
            provider: model.provider,
            model: model.id,
            thinking: effectiveThinking(model, thinking),
            ...(speed ? { speed } : {}),
          }
        : `No credentials for ${modelRef(model)}. Log in to ${model.provider} first.`;

    const openPicker = async (ctx: ExtensionCommandContext, initialSearch?: string) => {
      const current = choice;
      // The picker and request builder load on first use, not at startup.
      const { AdvisorPicker } = await import("./picker.ts");
      const result = await ctx.ui.custom<PickerResult | undefined>(
        (_tui, theme, _keybindings, done) =>
          new AdvisorPicker({
            theme,
            models: ctx.modelRegistry.getAvailable(),
            scoped: ctx.scopedModels.map((scoped) => scoped.model),
            speedSupport: (ctx.modelRegistry as Registry & RequestSpeedSupportLookup)[
              REQUEST_SPEED_SUPPORT
            ],
            ...(current
              ? {
                  current: {
                    model: ctx.modelRegistry.find(current.provider, current.model),
                    thinking: current.thinking ?? DEFAULT_THINKING,
                    speed: current.speed,
                  },
                }
              : {}),
            defaultThinking: DEFAULT_THINKING,
            ...(initialSearch ? { initialSearch } : {}),
            done,
          }),
      );
      if (!result) return;
      if (result.kind === "off") {
        await apply(ctx, undefined);
        return;
      }
      const next = toChoice(ctx, result.model, result.thinking, result.speed);
      if (typeof next === "string") ctx.ui.notify(next, "error");
      else await apply(ctx, next);
    };

    const completions = (prefix: string): AutocompleteItem[] | null => {
      if (!registry) return null;
      const query = prefix.trim();
      const speedArg = /^speed\s+(.*)$/.exec(prefix.trimStart());
      if (speedArg) {
        return REQUEST_SPEED_PREFERENCES.filter((speed) => speed.startsWith(speedArg[1] ?? "")).map(
          (speed) => ({ value: `speed ${speed}`, label: `speed ${speed}` }),
        );
      }
      const models = registry.getAvailable();
      const colon = query.lastIndexOf(":");
      if (colon > 0) {
        const ref = query.slice(0, colon);
        const model = models.find((candidate) => modelRef(candidate) === ref);
        if (model) {
          const items = getSupportedThinkingLevels(model)
            .filter((level) => level.startsWith(query.slice(colon + 1)))
            .map((level) => ({ value: `${ref}:${level}`, label: `${ref}:${level}` }));
          return items.length ? items : null;
        }
      }
      const items: AutocompleteItem[] = [
        { value: "off", label: "off", description: "Disable the advisor tool" },
        { value: "status", label: "status", description: "Show the advisor model and speed" },
        { value: "speed", label: "speed", description: "Set the advisor speed independently" },
        ...models.map((model) => ({
          value: modelRef(model),
          label: modelRef(model),
          description: model.name,
        })),
      ].filter((item) => item.value.includes(query));
      return items.length ? items.slice(0, 100) : null;
    };

    pi.on("session_start", async (_event, ctx) => {
      registry = ctx.modelRegistry;
      lastSpeed = undefined;
      try {
        choice = await loadAdvisorChoice(configPath);
      } catch (error) {
        choice = undefined;
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      setToolActive(choice !== undefined);
      showFooter(ctx);
    });

    // Fallback in case the assistant message carrying the advisor call is not yet persisted.
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") lastAssistant = event.message;
    });

    pi.registerCommand("advisor", {
      description:
        "Choose the advisor: /advisor [provider/model[:thinking] | speed | off | status]",
      getArgumentCompletions: completions,
      handler: async (args, ctx) => {
        registry = ctx.modelRegistry;
        const arg = args.trim();
        if (arg === "status" || (!arg && ctx.mode !== "tui")) {
          ctx.ui.notify(status(), "info");
          return;
        }
        if (/^speed(?:\s|$)/.test(arg)) {
          const speed = arg.slice("speed".length).trim().toLowerCase();
          if (!isRequestSpeedPreference(speed)) {
            ctx.ui.notify("Usage: /advisor speed inherit|standard|fast|ultrafast", "warning");
          } else if (!choice) {
            ctx.ui.notify("Choose an advisor with /advisor before setting its speed.", "warning");
          } else {
            await apply(ctx, { ...choice, speed });
          }
          return;
        }
        if (arg === "off") {
          await apply(ctx, undefined);
          return;
        }
        if (!arg) {
          await openPicker(ctx);
          return;
        }
        const spec = parseSpec(arg);
        const model = resolveModelRef(
          spec.ref,
          (provider, id) => ctx.modelRegistry.find(provider, id),
          candidates(ctx),
        );
        if (typeof model === "string") {
          // Like /model: an inexact name opens the picker filtered by it.
          if (ctx.mode === "tui") await openPicker(ctx, spec.ref);
          else ctx.ui.notify(model, "error");
          return;
        }
        const next = toChoice(ctx, model, spec.thinking);
        if (typeof next === "string") {
          ctx.ui.notify(next, "error");
          return;
        }
        await apply(ctx, next);
      },
    });

    pi.registerTool({
      name: ADVISOR_TOOL,
      label: "advisor",
      description:
        "Consult a stronger reviewer model. It takes no parameters: your full transcript, including every tool call and result, is forwarded automatically. Returns advice to weigh before continuing.",
      promptSnippet: "Consult a stronger reviewer model that sees your whole transcript",
      promptGuidelines: [
        "On multi-step tasks, call advisor alone (no other tool calls in the turn) before committing to an approach, when stuck, and before finishing; weigh its advice, and call again stating the conflict if your evidence contradicts it.",
      ],
      parameters: Type.Object({}, { additionalProperties: false }),
      defaultActive: false,
      executionMode: "sequential",

      async execute(toolCallId, _params, signal, onUpdate, ctx) {
        const current = choice;
        if (!current) {
          throw new Error("No advisor model is configured. The user can choose one with /advisor.");
        }
        const model = ctx.modelRegistry.find(current.provider, current.model);
        if (!model) throw new Error(`Advisor model ${formatChoice(current)} is not available.`);
        const thinking = effectiveThinking(model, current.thinking);
        const label = `${modelRef(model)}${thinking === "off" ? "" : `:${thinking}`}`;
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
          throw new Error(`Advisor model ${label} has no credentials.`);
        }

        const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
        if (
          !hasToolCall(messages, toolCallId) &&
          lastAssistant &&
          hasToolCall([lastAssistant], toolCallId)
        ) {
          messages.push(lastAssistant);
        }
        const active = new Set(pi.getActiveTools());
        // Stable per session and advisor model, and short enough for every provider's cache key.
        const cacheKey = `advisor-${createHash("sha256")
          .update(`${ctx.sessionManager.getSessionId()}\0${modelRef(model)}`)
          .digest("hex")
          .slice(0, 32)}`;
        const { ADVISOR_SYSTEM_PROMPT, buildAdvisorRequest } = await import("./prompt.ts");
        const request = buildAdvisorRequest({
          model,
          executorSystemPrompt: ctx.getSystemPrompt(),
          tools: pi
            .getAllTools()
            .filter((tool) => active.has(tool.name))
            .map((tool) => ({ name: tool.name, description: tool.description })),
          messages,
          cacheKey,
          previous: promptCache,
        });

        const running: AdvisorDetails = {
          status: "running",
          model: label,
          truncated: request.truncated,
          transcriptChars: request.transcriptChars,
        };
        onUpdate?.({ content: [{ type: "text", text: "" }], details: running });

        const started = Date.now();
        const speed: RequestSpeedControl = { preference: current.speed ?? "inherit" };
        const speedOptions: RequestSpeedOptions = { [REQUEST_SPEED]: speed };
        const stream = ctx.modelRegistry.streamSimple(
          model,
          {
            systemPrompt: ADVISOR_SYSTEM_PROMPT,
            messages: [{ role: "user", content: request.content, timestamp: started }],
          },
          {
            ...speedOptions,
            ...(thinking === "off" ? {} : { reasoning: thinking }),
            signal,
            sessionId: cacheKey,
            disableContinuation: true,
          },
        );

        let streamed = "";
        let lastUpdate = 0;
        for await (const event of stream) {
          if (event.type !== "text_delta") continue;
          streamed += event.delta;
          if (Date.now() - lastUpdate >= UPDATE_INTERVAL_MS) {
            lastUpdate = Date.now();
            onUpdate?.({ content: [{ type: "text", text: streamed }], details: running });
          }
        }
        const result = await stream.result();
        const report = speed.report?.();
        if (choice === current) lastSpeed = report;
        const speedNote = report ? ` (${formatSpeed(report)})` : "";
        if (result.stopReason === "aborted")
          throw new Error(`Advisor call was cancelled.${speedNote}`);
        if (result.stopReason === "error") {
          throw new Error(
            `Advisor ${label} failed: ${result.errorMessage ?? "unknown error"}${speedNote}`,
          );
        }
        promptCache = request.state;
        const advice = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        if (!advice) {
          throw new Error(
            `Advisor ${label} returned no advice (stop reason ${result.stopReason}).${speedNote}`,
          );
        }
        const note =
          result.stopReason === "length"
            ? "\n\n[Advice cut off at the advisor model's output limit.]"
            : "";
        return {
          content: [{ type: "text", text: advice + note }],
          details: {
            ...running,
            status: "done",
            usage: result.usage,
            durationMs: result.durationMs ?? Date.now() - started,
            stopReason: result.stopReason,
            ...(report ? { speed: report } : {}),
          } satisfies AdvisorDetails,
          usage: result.usage,
        };
      },

      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("advisor")), 0, 0);
      },

      renderResult(result, { expanded, isPartial }, theme) {
        const details = result.details as AdvisorDetails | undefined;
        const block = result.content.find((item) => item.type === "text");
        const text = block?.type === "text" ? block.text : "";
        if (!details) return new Text(text, 0, 0);

        const container = new Container();
        if (isPartial || details.status === "running") {
          container.addChild(new Text(theme.fg("muted", `Consulting ${details.model}…`), 0, 0));
          const tail = text.trimEnd().split("\n").slice(-4).join("\n");
          if (tail) container.addChild(new Text(theme.fg("dim", tail), 0, 0));
          return container;
        }

        const lines = text.split("\n");
        const collapsed = !expanded && lines.length > COLLAPSED_LINES;
        container.addChild(
          new Markdown(
            collapsed ? lines.slice(0, COLLAPSED_LINES).join("\n") : text,
            0,
            0,
            getMarkdownTheme(),
          ),
        );
        const hint = collapsed ? ` (${keyHint("app.tools.expand", "to expand")})` : "";
        container.addChild(new Text(theme.fg("dim", formatMeta(details) + hint), 0, 0));
        return container;
      },
    });
  };
}

export default createAdvisorExtension();
