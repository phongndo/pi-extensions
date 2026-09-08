import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setFooterStatus } from "../../src/footer-status.ts";
import {
  NOTE_TYPE,
  WINDOW_TYPE,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  MEMORY_TOOLS,
  windowBootstrap,
  currentNotes,
  recall,
  validateReferences,
  type NoteData,
} from "./model.ts";
import { MODES, isMode, loadMode, saveMode, verifyArchive, type ContextMode } from "./state.ts";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
  renderRecallCall,
  renderRecallResult,
  renderNotesCall,
  renderNotesResult,
  renderNewContextCall,
} from "./render.ts";

const strict = { additionalProperties: false };
const REQUEST_TYPE = "context.request";
const referenceSchema = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
  maxItems: 50,
  uniqueItems: true,
});

import {
  GUIDE,
  RESET_GUIDE,
  REMINDER,
  CONTINUE,
  RECALL_DESCRIPTION,
  NOTES_DESCRIPTION,
  NEW_CONTEXT_DESCRIPTION,
} from "./guidance.ts";

export interface ContextOptions {
  statePath?: string;
  pollMs?: number;
  reminderTokens?: number;
  rolloverTokens?: number;
  /** Test/embedding seam; no model calls are made by this extension. */
  verify?: typeof verifyArchive;
}

import { ResetController } from "./reset.ts";
import { withEvidenceIds } from "./provenance.ts";
import {
  EVENT_TYPE,
  IMPLEMENTATION_VERSION,
  diagnosticStatus,
  diagnostics,
  pendingUsage,
  type Diagnostic,
  type DiagnosticEvent,
} from "./diagnostics.ts";

interface Runtime {
  ctx: ExtensionContext;
  mode: ContextMode;
  suppressedTools: Set<string>;
  error: string | undefined;
  revision: number;
  refreshing: { revision: number; promise: Promise<boolean> } | undefined;
  reset: ResetController;
  timer: ReturnType<typeof setInterval> | undefined;
  attempt:
    | { reason: string; exp: boolean; windowId?: never }
    | { reason: "summary_free"; exp: true; windowId: string }
    | undefined;
  pendingUsage: string | undefined;
  requestedId: string | undefined;
  abortingForRollover: boolean;
  failureRecorded: boolean;
  diagnosticError: boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function latestUser(branch: readonly SessionEntry[]): string | undefined {
  return branch.filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1)
    ?.id;
}

function freshWindowWithoutProgress(branch: readonly SessionEntry[]): boolean {
  const boundary = branch.map((entry) => entry.type).lastIndexOf("compaction");
  const entry = branch[boundary];
  if (
    entry?.type !== "compaction" ||
    (entry.details as { context?: { version?: number } } | undefined)?.context?.version !== 2
  )
    return false;
  return !branch
    .slice(boundary + 1)
    .some(
      (item) =>
        item.type === "message" &&
        (item.message.role === "user" ||
          (item.message.role === "assistant" &&
            !["error", "aborted"].includes(item.message.stopReason))),
    );
}

export function createContextExtension(options: ContextOptions = {}): (pi: ExtensionAPI) => void {
  const statePath = options.statePath ?? join(getAgentDir(), "context.json");
  const verify = options.verify ?? verifyArchive;
  return (pi) => {
    let runtime: Runtime | undefined;

    const active = (session: Runtime) => runtime === session && !session.reset.closed;
    const notify = (
      ctx: ExtensionContext,
      value: string,
      level: "info" | "warning" | "error" = "info",
    ) => {
      if (ctx.hasUI) ctx.ui.notify(value, level);
    };
    function render(session: Runtime) {
      if (active(session) && session.ctx.hasUI)
        setFooterStatus(session.ctx, "context", `ctxt ${session.mode}${session.error ? " !" : ""}`);
    }
    function refresh(session: Runtime): Promise<boolean> {
      // Sibling tools and the poller share one read. Explicit preference writes
      // invalidate its revision, so callers after a write never join a stale read.
      if (session.refreshing?.revision === session.revision) return session.refreshing.promise;
      const promise = readPreference(session).finally(() => {
        if (session.refreshing?.promise === promise) session.refreshing = undefined;
      });
      session.refreshing = { revision: session.revision, promise };
      return promise;
    }
    async function readPreference(session: Runtime): Promise<boolean> {
      const revision = ++session.revision;
      try {
        const mode = await loadMode(statePath);
        if (active(session) && revision === session.revision) {
          session.mode = mode;
          session.error = undefined;
        }
      } catch (error) {
        if (active(session) && revision === session.revision) {
          // A broken preference must not turn a running experiment into summarization.
          session.error = message(error);
        }
      }
      if (active(session) && revision === session.revision) syncTools(session);
      render(session);
      return (
        active(session) && revision === session.revision && session.mode === "exp" && !session.error
      );
    }
    function record(
      session: Runtime,
      event: DiagnosticEvent,
      fields: Omit<Diagnostic, "version" | "implementation" | "event"> = {},
    ) {
      if (!active(session)) return;
      try {
        pi.appendEntry(EVENT_TYPE, {
          version: 1,
          implementation: IMPLEMENTATION_VERSION,
          mode: session.mode,
          event,
          ...fields,
        } satisfies Diagnostic);
      } catch {
        if (!session.diagnosticError)
          notify(
            session.ctx,
            "Context diagnostics could not be saved; context safety checks remain active.",
            "warning",
          );
        session.diagnosticError = true;
      }
    }
    function cancelRequest(session: Runtime, reason: string) {
      if (
        session.requestedId &&
        session.ctx.sessionManager.getBranch().some((entry) => entry.id === session.requestedId)
      )
        record(session, "cancelled", { reason, requestId: session.requestedId });
      session.requestedId = undefined;
    }
    // Change schemas only at idle boundaries, never underneath an executing tool batch.
    // Restore only tools this extension hid; preserve unrelated tools and initial allowlists.
    function syncTools(session: Runtime, restore = false) {
      if (!restore && !session.ctx.isIdle()) return;
      const current = pi.getActiveTools();
      if (session.mode === "default" && !restore) {
        const memory = current.filter((name) => MEMORY_TOOLS.includes(name));
        for (const name of memory) session.suppressedTools.add(name);
        if (memory.length)
          pi.setActiveTools(current.filter((name) => !MEMORY_TOOLS.includes(name)));
      } else if (session.suppressedTools.size) {
        pi.setActiveTools([...new Set([...current, ...session.suppressedTools])]);
        session.suppressedTools.clear();
      }
    }
    function memoryAvailable(): boolean {
      return runtime !== undefined && runtime.mode !== "default" && !runtime.error;
    }
    function toolsAvailable(): boolean {
      const tools = pi.getActiveTools();
      return MEMORY_TOOLS.every((name) => tools.includes(name));
    }
    function close() {
      if (!runtime) return;
      setFooterStatus(runtime.ctx, "context", undefined);
      cancelRequest(runtime, "session_shutdown");
      syncTools(runtime, true);
      runtime.reset.cancel(true);
      if (runtime.timer) clearInterval(runtime.timer);
      runtime = undefined;
    }
    function persistedAppend(ctx: ExtensionContext, customType: string, data: unknown): string {
      pi.appendEntry(customType, data);
      const entry = ctx.sessionManager.getBranch().at(-1);
      if (
        entry?.type !== "custom" ||
        entry.customType !== customType ||
        JSON.stringify(entry.data) !== JSON.stringify(data)
      )
        throw new Error("Could not confirm the saved context record.");
      return entry.id;
    }
    function continueTask(session: Runtime, text: string) {
      if (!active(session)) return;
      if (!session.ctx.isIdle() || session.ctx.hasPendingMessages()) {
        cancelRequest(session, "continuation_superseded");
        return;
      }
      pi.sendMessage(
        { customType: "context.continue", content: text, display: false },
        { triggerTurn: true },
      );
      record(session, "resumed", session.requestedId ? { requestId: session.requestedId } : {});
      session.requestedId = undefined;
    }

    pi.registerCommand("context", {
      description:
        "Global context mode: default (Pi summaries), exp (summary-free rollover), status",
      getArgumentCompletions: (prefix) =>
        [...MODES, "status"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const input = args.trim().toLowerCase() || "status";
        const action = input === "on" ? "exp" : input === "off" ? "default" : input;
        if (action !== "status" && !isMode(action)) {
          notify(
            ctx,
            "Usage: /context [default|exp|status] (aliases: on=exp, off=default)",
            "warning",
          );
          return;
        }
        const session = runtime;
        if (!session) {
          notify(ctx, "Context has no active session.", "error");
          return;
        }
        session.ctx = ctx;
        try {
          if (action !== "status") {
            session.revision++;
            await saveMode(statePath, action as ContextMode);
          }
          await refresh(session);
          if (!active(session)) return;
          notify(
            ctx,
            session.error ??
              `Context ${session.mode}${action === "status" ? ` · ${diagnosticStatus(ctx.sessionManager.getBranch())}` : ""}${!ctx.isIdle() ? " · tool visibility updates when idle" : ""}`,
            session.error ? "error" : "info",
          );
        } catch (error) {
          if (active(session)) notify(ctx, message(error), "error");
        }
      },
    });

    pi.registerTool({
      name: "recall",
      label: "Recall",
      renderCall: renderRecallCall,
      renderResult: (result, options, theme, context) =>
        renderRecallResult(result, options, theme, context.isError),
      description: RECALL_DESCRIPTION,
      promptSnippet: "Recall saved session evidence and notes after compaction",
      parameters: Type.Object(
        {
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          entryId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
          cursor: Type.Optional(Type.String({ maxLength: 1024 })),
          role: Type.Optional(
            Type.String({
              enum: [
                "user",
                "assistant",
                "toolResult",
                "bashExecution",
                "custom",
                "note",
                "checkpoint",
                "compaction",
                "branch_summary",
              ],
            }),
          ),
          toolName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          source: Type.Optional(Type.String({ enum: ["all", "original", "derived", "notes"] })),
          window: Type.Optional(Type.String({ enum: ["all", "current", "previous"] })),
        },
        strict,
      ),
      async execute(_id, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (!memoryAvailable())
          throw new Error("Memory tools are disabled in default mode; select exp.");
        const result = recall(
          ctx.sessionManager.getBranch(),
          params as Parameters<typeof recall>[1],
        );
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      },
    });

    function requestWindow(session: Runtime, ctx: ExtensionContext, reason: string, resume = true) {
      if (session.requestedId) return session.requestedId;
      const entryId = persistedAppend(ctx, REQUEST_TYPE, {
        version: 1,
        reason,
        resume,
        userId: latestUser(ctx.sessionManager.getBranch()),
      });
      session.reset.request(entryId);
      session.requestedId = entryId;
      record(session, "reset_requested", { reason, requestId: entryId });
      return entryId;
    }

    pi.registerTool({
      name: "new_context",
      label: "New context",
      renderCall: renderNewContextCall,
      renderResult: (result, options, theme, context) =>
        renderNotesResult(result, options, theme, context.isError),
      description: NEW_CONTEXT_DESCRIPTION,
      promptSnippet: "Start a fresh context window without summarizing history",
      parameters: Type.Object({}, strict),
      async execute(_callId, _params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        const session = runtime;
        if (!session || !(await refresh(session)))
          throw new Error("Memory tools are unavailable; select exp with a readable preference.");
        signal?.throwIfAborted();
        if (!toolsAvailable()) throw new Error("recall, notes, and new_context must be active.");
        if (!ctx.sessionManager.getSessionFile())
          throw new Error("Rollover requires a persisted session archive.");
        if (ctx.hasPendingMessages())
          throw new Error("Handle queued input before requesting a new window.");
        const entryId = requestWindow(session, ctx, "requested");
        signal?.addEventListener(
          "abort",
          () => {
            if (
              session.requestedId === entryId &&
              session.reset.requested &&
              !session.abortingForRollover
            ) {
              session.reset.cancel();
              cancelRequest(session, "signal_aborted");
            }
          },
          { once: true },
        );
        return {
          content: [
            {
              type: "text",
              text: "Fresh context window requested after this tool batch, without summarization. Files, environment and archived history are unchanged. The task will continue automatically.",
            },
          ],
          details: { entryId },
          terminate: true,
        };
      },
    });

    pi.registerTool({
      name: "notes",
      label: "Notes",
      renderCall: renderNotesCall,
      renderResult: (result, options, theme, context) =>
        renderNotesResult(result, options, theme, context.isError),
      description: NOTES_DESCRIPTION,
      promptSnippet: "Save, update, or delete reusable task notes",
      parameters: Type.Object(
        {
          action: Type.String({ enum: ["write", "append", "delete"] }),
          name: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$" }),
          text: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
          revision: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          references: Type.Optional(referenceSchema),
        },
        strict,
      ),
      async execute(_callId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (!memoryAvailable())
          throw new Error("Memory tools are disabled in default mode; select exp.");
        const branch = ctx.sessionManager.getBranch();
        const refs = [...(params.references ?? [])];
        validateReferences(refs, branch);
        if (!params.name || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(params.name))
          throw new Error("Use a logical note name, not a filesystem path.");
        const notes = currentNotes(branch);
        const previous = notes.get(params.name);
        if (params.revision !== undefined && previous?.entryId !== params.revision)
          throw new Error(
            "Note revision changed or is unavailable; use recall to read its current revision.",
          );
        if (previous && params.action !== "append" && params.revision !== previous.entryId)
          throw new Error(
            `Replacing/deleting ${params.name} requires revision ${previous.entryId}.`,
          );
        if (params.action === "delete" && !previous)
          throw new Error("Note does not exist on this branch.");
        if (!["write", "append", "delete"].includes(params.action))
          throw new Error("Unknown notes action.");
        if (params.action !== "delete" && !params.text?.trim())
          throw new Error("Note text must not be empty.");
        if (params.action === "delete" && params.text !== undefined)
          throw new Error("delete does not accept text.");
        const noteText =
          params.action === "delete"
            ? ""
            : params.action === "append"
              ? (previous?.data.text ?? "") + params.text!
              : params.text!;
        if (noteText.length > MAX_NOTE_CHARS)
          throw new Error("Note exceeds 12000 characters; use another note.");
        if (!previous && notes.size >= MAX_NOTES)
          throw new Error("Too many notes; remove obsolete notes before adding another.");
        const noteRefs =
          params.action === "append"
            ? [...new Set([...(previous?.data.references ?? []), ...refs])]
            : refs;
        if (noteRefs.length > 64) throw new Error("Too many references; split the note.");
        const data: NoteData = {
          version: 1,
          name: params.name,
          text: noteText,
          references: noteRefs,
          deleted: params.action === "delete",
        };
        // No await between revision validation and append: sibling writes see the new revision.
        const entryId = persistedAppend(ctx, NOTE_TYPE, data);
        return {
          content: [
            {
              type: "text",
              text: `Note ${params.name} ${data.deleted ? "deleted" : "saved"}; revision ${entryId}. Read this entryId with recall.`,
            },
          ],
          details: { entryId },
        };
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      close();
      const session: Runtime = {
        ctx,
        mode: "default",
        suppressedTools: new Set(),
        error: undefined,
        revision: 0,
        refreshing: undefined,
        reset: new ResetController(),
        timer: undefined,
        attempt: undefined,
        pendingUsage: pendingUsage(ctx.sessionManager.getBranch()),
        requestedId: undefined,
        abortingForRollover: false,
        failureRecorded: false,
        diagnosticError: false,
      };
      runtime = session;
      await refresh(session);
      if (!active(session)) return;
      record(session, "activation", {
        enabled: session.mode === "exp",
        reason: session.error ? "preference_error" : "session_start",
      });
      if (session.error) notify(ctx, session.error, "warning");
      if ((options.pollMs ?? 2000) > 0) {
        let polling = false;
        session.timer = setInterval(() => {
          if (polling || !active(session)) return;
          polling = true;
          void refresh(session).finally(() => {
            polling = false;
          });
        }, options.pollMs ?? 2000);
        session.timer.unref();
      }
    });
    pi.on("session_shutdown", close);
    pi.on("session_tree", (_event, ctx) => {
      if (runtime) {
        cancelRequest(runtime, "tree_navigation");
        runtime.reset.cancel();
        runtime.attempt = undefined;
        runtime.pendingUsage = pendingUsage(ctx.sessionManager.getBranch());
        runtime.ctx = ctx;
        render(runtime);
      }
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const session = runtime;
      if (!session) return;
      session.ctx = ctx;
      const enabled = await refresh(session);
      if (!active(session) || !memoryAvailable() || !toolsAvailable()) return;
      return {
        systemPrompt:
          event.systemPrompt +
          GUIDE +
          (enabled && ctx.sessionManager.getSessionFile()
            ? RESET_GUIDE
            : "Rollover needs a persisted archive; report unavailable rollover, never substitute a summary.\n"),
      };
    });
    pi.on("context", (event, ctx) => {
      const session = runtime;
      if (!session || !memoryAvailable() || !toolsAvailable()) return;
      const branch = ctx.sessionManager.getBranch();
      const messages = withEvidenceIds(event.messages, branch);
      const usage = ctx.getContextUsage();
      if (
        session.mode === "exp" &&
        !session.error &&
        ctx.sessionManager.getSessionFile() &&
        ctx.model &&
        usage?.tokens &&
        ctx.model.contextWindow - usage.tokens <=
          Math.min(options.reminderTokens ?? 32_768, ctx.model.contextWindow / 3)
      ) {
        const window =
          branch.filter((entry) => entry.type === "compaction").at(-1)?.id ?? "initial";
        if (
          !diagnostics(branch).some(
            (event) => event.event === "reminder" && event.compactionId === window,
          )
        )
          record(session, "reminder", { compactionId: window, tokensBefore: usage.tokens });
        messages.push({
          role: "custom",
          customType: "context.reminder",
          content: REMINDER,
          display: false,
          timestamp: Date.now(),
        });
      }
      return messages.length !== event.messages.length ||
        messages.some((message, i) => message !== event.messages[i])
        ? { messages }
        : undefined;
    });

    pi.on("session_before_compact", async (event, ctx) => {
      const session = runtime;
      if (!session) return;
      session.failureRecorded = false;
      // Never let an error in the experimental path fall through to Pi's summarizer.
      const wasExp = session.mode === "exp";
      try {
        await refresh(session);
        session.attempt = { reason: session.mode, exp: session.mode === "exp" };
        if (!active(session)) return { cancel: true };
        if (session.mode === "default" && !session.error) return;
        if (session.error)
          throw new Error("Context preference could not be read; rollover stopped.");
        if (!toolsAvailable())
          throw new Error("recall, notes, and new_context must all be active.");
        if (ctx.hasPendingMessages())
          throw new Error("Queued user input must be handled before rollover.");
        if (event.customInstructions?.trim())
          throw new Error(
            "Summary instructions are unavailable in exp; use /compact without instructions or select default.",
          );
        if (event.reason === "overflow" && freshWindowWithoutProgress(event.branchEntries))
          throw new Error(
            "Fresh context already overflowed; another rollover cannot remove more history.",
          );
        const beforeLeaf = ctx.sessionManager.getLeafId();
        if (event.branchEntries.at(-1)?.id !== beforeLeaf)
          throw new Error("Session branch changed after rollover preparation.");
        event.signal.throwIfAborted();
        const summary = windowBootstrap(event.branchEntries);
        if (
          !ctx.model ||
          (Buffer.byteLength(summary) + Buffer.byteLength(ctx.getSystemPrompt())) / 3 + 1024 >
            ctx.model.contextWindow * 0.75
        )
          throw new Error(
            "Recovery instructions and system prompt leave insufficient context headroom.",
          );
        // This marker adds no retained conversation tail. Verification covers both it
        // and every original branch entry; notes/checkpoints are never prerequisites.
        const boundary = persistedAppend(ctx, WINDOW_TYPE, { version: 2, through: beforeLeaf });
        await verify(
          ctx.sessionManager.getSessionFile(),
          ctx.sessionManager.getBranch(),
          event.signal,
        );
        if (
          !(await refresh(session)) ||
          !active(session) ||
          !toolsAvailable() ||
          ctx.hasPendingMessages() ||
          ctx.sessionManager.getLeafId() !== boundary
        )
          throw new Error(
            "Session, preference, or pending input changed during rollover verification.",
          );
        event.signal.throwIfAborted();
        session.attempt = { reason: "summary_free", windowId: boundary, exp: true };
        return {
          compaction: {
            // Pi's required field carries deterministic recovery pointers, NOT a summary.
            summary: `Window ${boundary}. ${summary}`,
            firstKeptEntryId: boundary,
            tokensBefore: event.preparation.tokensBefore,
            details: { context: { version: 2, windowId: boundary } },
          },
        };
      } catch (error) {
        session.attempt = {
          reason: event.signal.aborted ? "rollover_aborted" : "rollover_blocked",
          exp: wasExp || session.mode === "exp",
        };
        if (!event.signal.aborted)
          notify(
            ctx,
            `Context rollover failed: ${message(error)} No summary was generated.`,
            "error",
          );
        return { cancel: true };
      }
    });
    pi.on("session_compact", (event) => {
      const session = runtime;
      if (!session) return;
      const entry = event.compactionEntry;
      const details = entry.details as
        | { context?: { version?: number; windowId?: string } }
        | undefined;
      const fresh =
        session.attempt?.windowId !== undefined &&
        entry.fromHook === true &&
        details?.context?.version === 2 &&
        details.context.windowId === session.attempt?.windowId &&
        entry.firstKeptEntryId === session.attempt?.windowId;
      if (fresh && event.willRetry) {
        // Pi's overflow loop retries before agent_settled. Do not schedule a
        // second continuation when that already-retried run eventually settles.
        session.reset.cancel();
        session.requestedId = undefined;
      } else if (fresh) session.reset.compacted();
      else if (session.attempt?.exp) {
        session.reset.cancel();
        cancelRequest(session, "overridden");
        notify(
          session.ctx,
          "Another extension overrode summary-free rollover. Disable competing compaction policies.",
          "error",
        );
      }
      record(session, "compaction", {
        outcome: fresh ? "fresh" : entry.fromHook ? "other" : "normal",
        reason: fresh
          ? "summary_free"
          : session.attempt?.exp
            ? "overridden"
            : (session.attempt?.reason ?? "unknown"),
        compactionId: entry.id,
        tokensBefore: entry.tokensBefore,
      });
      session.attempt = undefined;
      session.pendingUsage = entry.id;
      render(session);
    });
    pi.on("session_compact_failed", (event) => {
      const session = runtime;
      if (!session) return;
      record(
        session,
        event.aborted && session.attempt?.reason !== "rollover_blocked"
          ? "cancelled"
          : "compaction_failed",
        {
          reason:
            session.attempt?.reason ?? (event.aborted ? "compaction_aborted" : "host_rejected"),
        },
      );
      if (session.mode === "exp" && !event.aborted)
        notify(
          session.ctx,
          "Context rollover failed; history is retained. No summary fallback is allowed in exp.",
          "error",
        );
      session.failureRecorded = true;
      session.attempt = undefined;
      // Every terminal failure consumes the request, not just user aborts.
      // Otherwise agent_settled retries a failed native compaction implicitly.
      session.reset.cancel();
      session.requestedId = undefined;
    });
    pi.on("turn_end", (event) => {
      const session = runtime;
      if (
        !session?.pendingUsage ||
        event.message?.role !== "assistant" ||
        event.message.stopReason === "error" ||
        event.message.stopReason === "aborted"
      )
        return;
      const branch = session.ctx.sessionManager.getBranch();
      const boundaryIndex = branch.findIndex((entry) => entry.id === session.pendingUsage);
      const boundary = branch[boundaryIndex];
      if (!boundary) return;
      // Millisecond clocks can tie (or move backwards). Persisted ancestry establishes
      // causality when the timestamp alone would reject a genuine post-reset response.
      if (
        event.message.timestamp <= Date.parse(boundary.timestamp) &&
        !branch
          .slice(boundaryIndex + 1)
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              JSON.stringify(entry.message) === JSON.stringify(event.message),
          )
      )
        return;
      const usage = event.message.usage;
      const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (!Number.isFinite(inputTokens) || inputTokens < 0) return;
      record(session, "post_reset_usage", { compactionId: session.pendingUsage, inputTokens });
      session.pendingUsage = undefined;
    });
    // Own the budget trigger too: exp does not depend on Pi's auto-compaction setting.
    // End a completed tool batch before another model request; never compact reentrantly.
    pi.on("turn_end", (event, ctx) => {
      const session = runtime;
      // Pi's terminate hint requires every sibling result to agree. End a mixed
      // batch here too, after all receipts are persisted, without treating our
      // own abort as user cancellation of the requested window.
      if (
        session?.requestedId &&
        session.reset.requested &&
        event.message?.role === "assistant" &&
        event.message.stopReason === "toolUse" &&
        event.toolResults?.length > 1 &&
        !ctx.hasPendingMessages()
      ) {
        session.abortingForRollover = true;
        ctx.abort();
        return;
      }
      if (
        !session ||
        session.mode !== "exp" ||
        session.requestedId ||
        !ctx.model ||
        ctx.hasPendingMessages() ||
        event.message?.role !== "assistant" ||
        event.message.stopReason === "aborted"
      )
        return;
      const overflow = isContextOverflow(event.message, ctx.model.contextWindow);
      const tokens = ctx.getContextUsage()?.tokens ?? 0;
      const reserve = Math.min(options.rolloverTokens ?? 16_384, ctx.model.contextWindow / 8);
      if (!overflow && tokens < ctx.model.contextWindow - reserve) return;
      if (session.error || !toolsAvailable()) {
        notify(
          ctx,
          "Automatic rollover is unavailable: repair the context preference and enable all memory tools. No summary fallback.",
          "error",
        );
        ctx.abort();
        return;
      }
      if (overflow && freshWindowWithoutProgress(ctx.sessionManager.getBranch())) {
        notify(
          ctx,
          "Fresh context still exceeds the model limit; reduce overhead or use a larger window. No summary fallback.",
          "error",
        );
        ctx.abort();
        return;
      }
      if (!ctx.sessionManager.getSessionFile()) {
        notify(
          ctx,
          "Automatic rollover needs a persisted archive; no summary fallback in exp.",
          "error",
        );
        ctx.abort();
        return;
      }
      requestWindow(
        session,
        ctx,
        overflow ? "overflow" : "budget",
        overflow || event.message.stopReason === "toolUse",
      );
      ctx.abort();
    });

    pi.on("agent_settled", (_event, ctx) => {
      const session = runtime;
      if (session) {
        session.ctx = ctx;
        syncTools(session);
      }
      const pending = session?.reset.take();
      if (session) session.abortingForRollover = false;
      if (!session || !pending) return;
      session.ctx = ctx;
      if (ctx.hasPendingMessages()) {
        cancelRequest(session, "queued_input");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const request = branch.find((entry) => entry.id === pending.requestId);
      const data =
        request?.type === "custom" && request.customType === REQUEST_TYPE
          ? (request.data as { userId?: string; resume?: boolean })
          : undefined;
      if (!data || data.userId !== latestUser(branch)) {
        cancelRequest(session, "newer_input");
        return;
      }
      const resume = () => {
        if (data.userId !== latestUser(ctx.sessionManager.getBranch())) {
          cancelRequest(session, "newer_input");
          return;
        }
        if (data.resume) continueTask(session, CONTINUE);
        else session.requestedId = undefined;
      };
      if (pending.compacted) {
        resume();
        return;
      }
      if (session.mode !== "exp" || session.error) {
        cancelRequest(session, "mode_unavailable");
        notify(
          ctx,
          "Rollover stopped because exp became unavailable; original history remains active.",
          "warning",
        );
        return;
      }
      const finish = session.reset.begin();
      session.failureRecorded = false;
      ctx.compact({
        onComplete: () => {
          if (!finish()) return;
          resume();
        },
        onError: (error) => {
          if (!finish()) return;
          if (!active(session)) return;
          const aborted = /abort|cancel/i.test(message(error));
          if (!session.failureRecorded)
            record(session, aborted ? "cancelled" : "compaction_failed", {
              reason: aborted ? "compaction_aborted" : "host_rejected",
            });
          session.attempt = undefined;
          if (aborted) {
            session.requestedId = undefined;
            return;
          }
          session.requestedId = undefined;
          notify(
            ctx,
            `Context rollover failed: ${message(error)} Original history remains; no summary fallback.`,
            "error",
          );
        },
      });
    });
  };
}

export default createContextExtension();
