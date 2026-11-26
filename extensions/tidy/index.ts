import type {
  ExtensionAPI,
  ExtensionContext,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { loadConfig, saveConfig, type TidyConfig } from "./config.ts";
import { ownsItsRow } from "./builtins.ts";
import { createRenderers, EXPLORE, RowIndex } from "./render.ts";
import { Timeline, type DisplayOptions } from "./timeline.ts";

export const PROSE_SECTION = "response-style";

/** Answer-first defaults for prose. The user's own formatting requests win. */
export const PROSE_GUIDANCE = [
  "Defaults for replies; the user's explicit formatting requests take precedence:",
  "- Lead with the answer or outcome; skip preamble and restating the request.",
  "- While working, keep progress notes to a short sentence before related tool calls rather than narrating each call.",
  "- In a final report, cover what changed, how it was verified, and anything left open.",
  "- Prefer short paragraphs or flat bullets, and point at code as `path:line` when a location matters.",
  "- Summarize long command output or file contents rather than pasting them.",
].join("\n");

/** Prefix a user prompt with `›`, unless it opens with Markdown block syntax that a prefix would break. */
export function markUserPrompt(markdown: string): string {
  const first = markdown.split("\n", 1)[0] ?? "";
  if (first.trim() === "" || /^\s*(?:[#>*+|<-]|\d+[.)]\s|```|~~~)/.test(first)) return markdown;
  return `› ${markdown}`;
}

const COMMANDS = ["on", "off", "status"];

function applyUi(ctx: ExtensionContext, config: TidyConfig): void {
  if (!ctx.hasUI) return;
  // An empty label hides the line entirely, spacing included; undefined restores Pi's default.
  ctx.ui.setHiddenThinkingLabel(config.enabled ? "" : undefined);
}

interface NoticeSettings {
  hideThinkingBlock?: boolean;
  /** Pi 1.6.1+: one switch per notice. */
  notices?: { cacheMisses?: boolean; cacheWarming?: boolean; reasoningDrops?: boolean };
  /** Pi 1.5.x: one switch for cache-miss, cache-warming and reasoning-drop notices. */
  showCacheMissNotices?: boolean;
}

/** Pi's settings that decide what it draws between tool rows. */
export function displayOptions(settings: NoticeSettings, ctx?: ExtensionContext): DisplayOptions {
  const legacy = settings.showCacheMissNotices === true;
  const notice = (key: keyof NonNullable<NoticeSettings["notices"]>) =>
    settings.notices?.[key] ?? legacy;
  return {
    showThinking: settings.hideThinkingBlock !== true,
    cacheMissNotices: notice("cacheMisses"),
    cacheWarmingNotices: notice("cacheWarming"),
    reasoningDropNotices: notice("reasoningDrops"),
    cacheReadCost: (provider, model) => {
      try {
        return ctx?.modelRegistry.find(provider, model)?.cost.cacheRead;
      } catch {
        // A ctx gone stale after a reload or session switch: the next session_start replaces it.
        return undefined;
      }
    },
  };
}

/**
 * Another renderer's row, passed through unchanged except that each call it draws is noted as
 * standing apart from runs of reads. Per call, not per tool, so a later change of renderer does
 * not move rows already drawn.
 */
export function standApart(inner: ToolRenderers, index: RowIndex): ToolRenderers {
  // Live rows draw their call before execution starts; an export draws finished calls, and must
  // not change the live transcript. A result-only renderer is seen live once its row is rebuilt.
  const note = (context: { toolCallId: string; executionStarted: boolean }) => {
    if (!context.executionStarted) index.setApart(context.toolCallId, true);
  };
  const { renderCall, renderResult } = inner;
  return {
    ...inner,
    ...(renderCall
      ? {
          renderCall: (args, theme, context) => {
            note(context);
            return renderCall(args, theme, context);
          },
        }
      : {}),
    ...(renderResult
      ? {
          renderResult: (result, options, theme, context) => {
            note(context);
            return renderResult(result, options, theme, context);
          },
        }
      : {}),
  };
}

export default async function tidy(pi: ExtensionAPI): Promise<void> {
  let config = await loadConfig();
  const index = new RowIndex();
  let current: ExtensionContext | undefined;
  let settings: NoticeSettings = {};
  const timeline = new Timeline(
    () => {
      // Rows drawn after a reload or session switch can still reach this instance, whose pi is
      // then stale and throws: keep drawing with the settings last read.
      try {
        settings = pi.getSettings() as NoticeSettings;
      } catch {}
      return displayOptions(settings, current);
    },
    // Calls that stand apart (another renderer's rows, image reads) end a run of reads.
    (name, id) => EXPLORE.has(name) && !index.isApart(id),
  );
  index.onApartChange = () => timeline.changed();
  timeline.onCompacted = (ids) => index.retain(ids);
  // Tool renderers arrived in Pi 1.0.1: on an older Pi, leave tool rows alone.
  const canRender = typeof pi.registerToolRenderer === "function";
  const canTransform = typeof pi.registerMarkdownTransformer === "function";

  if (canRender)
    pi.registerToolRenderer((toolName, next) => {
      const inner = next();
      if (!config.enabled) return inner;
      return ownsItsRow(inner)
        ? standApart(inner!, index)
        : createRenderers(toolName, inner, index, timeline);
    });

  if (canTransform)
    pi.registerMarkdownTransformer(
      (markdown) => (config.enabled ? markUserPrompt(markdown) : markdown),
      { messageTypes: ["user"] },
    );

  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    const session = ctx.sessionManager;
    // Pi draws the compaction-aware entries; the cache-miss scan reads every entry.
    timeline.reset({
      context: () => session.buildContextEntries(),
      all: () => session.getEntries(),
      branch: () => session.getBranch(),
      leafId: () => session.getLeafId(),
    });
    applyUi(ctx, config);
    if (!canRender && ctx.hasUI)
      ctx.ui.notify(
        "tidy: this Pi cannot restyle tool rows; update to Pi 1.5.2 or later",
        "warning",
      );
  });
  // Rows group by what lies between them, so follow the transcript as it grows.
  const follow = ({ message }: { message: { role: string } }) => {
    if (message.role === "assistant") timeline.setLive(message);
    else timeline.changed();
  };
  pi.on("message_start", follow);
  pi.on("message_update", follow);
  pi.on("message_end", (event) => {
    // Before Pi saves the response, as Pi itself decides on its live-only notices.
    if (event.message.role === "assistant") timeline.noteResponseEnd(event.message);
    follow(event);
  });
  pi.on("turn_end", () => timeline.changed());
  pi.on("session_tree", () => {
    // The streaming response belonged to the branch just left.
    timeline.clearLive();
    timeline.changed();
  });
  pi.on("session_compact", () => timeline.changed());

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections;
    if (config.enabled) sections[PROSE_SECTION] = PROSE_GUIDANCE;
    else delete sections[PROSE_SECTION];
  });

  pi.registerCommand("tidy", {
    description: "Compact transcript: /tidy on|off",
    getArgumentCompletions: (prefix): AutocompleteItem[] =>
      COMMANDS.filter((item) => item.startsWith(prefix.trim().toLowerCase())).map((item) => ({
        value: item,
        label: item,
      })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "" || arg === "status") {
        ctx.ui.notify(`tidy is ${config.enabled ? "on" : "off"}`, "info");
        return;
      }
      if (arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /tidy on|off", "warning");
        return;
      }
      config = { enabled: arg === "on" };
      await saveConfig(config);
      applyUi(ctx, config);
      ctx.ui.notify(`tidy is ${arg}; /reload to redraw earlier tool rows`, "info");
    },
  });
}
