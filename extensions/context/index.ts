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
  CHECKPOINT_TYPE,
  WINDOW_TYPE,
  MAX_NOTE_CHARS,
  MAX_NOTES,
  bootstrap,
  checkpointProblem,
  currentNotes,
  isCheckpoint,
  latestCheckpoint,
  recall,
  validateReferences,
  type NoteData,
  type CheckpointData,
} from "./model.ts";
import { MODES, isMode, loadMode, saveMode, verifySavedEntry, type ContextMode } from "./state.ts";
import {
  renderRecallCall,
  renderRecallResult,
  renderNotesCall,
  renderNotesResult,
} from "./render.ts";

const strict = { additionalProperties: false };
const text = () => Type.String({ minLength: 1, maxLength: 3000 });
const checkpointSchema = Type.Object(
  { goal: text(), constraints: text(), progress: text(), nextSteps: text() },
  strict,
);
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
} from "./guidance.ts";

export interface ContextOptions {
  statePath?: string;
  pollMs?: number;
  reminderTokens?: number;
  /** Test/embedding seam; no model calls are made by this extension. */
  verify?: typeof verifySavedEntry;
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
  reset: ResetController;
  timer: ReturnType<typeof setInterval> | undefined;
  attempt: { reason: string; checkpointId?: string; windowId?: string } | undefined;
  pendingUsage: string | undefined;
  requestedId: string | undefined;
  failureRecorded: boolean;
  diagnosticError: boolean;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function checkpointCall(branch: readonly SessionEntry[], callId: string): SessionEntry {
  const last = branch.filter((entry) => entry.type === "message").at(-1);
  if (last?.type !== "message" || last.message.role !== "assistant")
    throw new Error("Checkpoint must follow its assistant tool call.");
  const calls = last.message.content.filter((block) => block.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== callId || calls[0].name !== "notes")
    throw new Error(
      "Call notes checkpoint alone, without sibling tools, so every earlier tool result is covered.",
    );
  return last;
}

export function createContextExtension(options: ContextOptions = {}): (pi: ExtensionAPI) => void {
  const statePath = options.statePath ?? join(getAgentDir(), "context.json");
  const verify = options.verify ?? verifySavedEntry;
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
    async function refresh(session: Runtime): Promise<boolean> {
      const revision = ++session.revision;
      try {
        const mode = await loadMode(statePath);
        if (active(session) && revision === session.revision) {
          session.mode = mode;
          session.error = undefined;
        }
      } catch (error) {
        if (active(session) && revision === session.revision) {
          session.mode = "default";
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
        record(session, "cancelled", { reason, checkpointId: session.requestedId });
      session.requestedId = undefined;
    }
    // Change schemas only at idle boundaries, never underneath an executing tool batch.
    // Restore only tools this extension hid; preserve unrelated tools and initial allowlists.
    function syncTools(session: Runtime, restore = false) {
      if (!restore && !session.ctx.isIdle()) return;
      const current = pi.getActiveTools();
      if (session.mode === "default" && !restore) {
        const memory = current.filter((name) => name === "recall" || name === "notes");
        for (const name of memory) session.suppressedTools.add(name);
        if (memory.length)
          pi.setActiveTools(current.filter((name) => name !== "recall" && name !== "notes"));
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
      return tools.includes("recall") && tools.includes("notes");
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
      if (!active(session) || !session.ctx.isIdle() || session.ctx.hasPendingMessages()) return;
      pi.sendMessage(
        { customType: "context.continue", content: text, display: false },
        { triggerTurn: true },
      );
      record(session, "resumed", session.requestedId ? { checkpointId: session.requestedId } : {});
      session.requestedId = undefined;
    }

    pi.registerCommand("context", {
      description: "Global context mode: default (Pi), exp (fresh + recall/notes), status",
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

    pi.registerTool({
      name: "notes",
      label: "Notes",
      renderCall: renderNotesCall,
      renderResult: (result, options, theme, context) =>
        renderNotesResult(result, options, theme, context.isError),
      description: NOTES_DESCRIPTION,
      promptSnippet: "Save durable task notes and verified continuation checkpoints",
      parameters: Type.Object(
        {
          action: Type.String({ enum: ["write", "append", "delete", "checkpoint"] }),
          name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$" })),
          text: Type.Optional(Type.String({ maxLength: MAX_NOTE_CHARS })),
          revision: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          references: Type.Optional(referenceSchema),
          checkpoint: Type.Optional(checkpointSchema),
          reset: Type.Optional(Type.Boolean()),
        },
        strict,
      ),
      async execute(callId, params, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (!memoryAvailable())
          throw new Error("Memory tools are disabled in default mode; select exp.");
        const originalSession = runtime;
        const branch = ctx.sessionManager.getBranch();
        const refs = [...(params.references ?? [])];
        validateReferences(refs, branch);
        if (params.action === "checkpoint") {
          if (
            !isCheckpoint(params.checkpoint) ||
            params.name !== undefined ||
            params.text !== undefined ||
            params.revision !== undefined
          )
            throw new Error(
              "checkpoint needs the structured checkpoint object, references, and optional reset only.",
            );
          const through = checkpointCall(branch, callId);
          const lastUser = branch
            .filter((entry) => entry.type === "message" && entry.message.role === "user")
            .at(-1);
          if (!lastUser)
            throw new Error("Cannot checkpoint a task without a recorded user request.");
          if (!refs.includes(lastUser.id)) refs.push(lastUser.id);
          const data: CheckpointData = {
            version: 1,
            checkpoint: params.checkpoint,
            references: refs,
            coveredThrough: through.id,
            toolCallId: callId,
          };
          const entryId = persistedAppend(ctx, CHECKPOINT_TYPE, data);
          await verify(ctx.sessionManager.getSessionFile(), entryId, data);
          signal?.throwIfAborted();
          const session = originalSession;
          if (params.reset && session && (await refresh(session))) {
            signal?.throwIfAborted();
            if (!active(session) || !toolsAvailable())
              throw new Error("recall and notes must remain active before resetting context.");
            if (ctx.hasPendingMessages()) {
              record(session, "cancelled", { reason: "queued_input", checkpointId: entryId });
              return {
                content: [
                  {
                    type: "text",
                    text: `Checkpoint ${entryId} saved. Handle the queued user input before checkpointing again; no reset requested.`,
                  },
                ],
                details: { entryId },
              };
            }
            const problem = checkpointProblem(
              ctx.sessionManager.getBranch(),
              { entryId, data },
              true,
            );
            if (problem) throw new Error(problem);
            session.reset.request(entryId, signal);
            session.requestedId = entryId;
            record(session, "reset_requested", { checkpointId: entryId });
            signal?.addEventListener(
              "abort",
              () => {
                if (active(session) && session.requestedId === entryId)
                  cancelRequest(session, "signal_aborted");
              },
              { once: true },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Checkpoint ${entryId} saved and verified. Fresh-window reset requested after this tool batch; the task will continue automatically.`,
                },
              ],
              details: { entryId },
              terminate: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Checkpoint ${entryId} saved and verified.${params.reset ? " Context resets are off/unavailable; continue in the existing window." : ""}`,
              },
            ],
            details: { entryId },
          };
        }
        if (params.checkpoint !== undefined || params.reset !== undefined)
          throw new Error("checkpoint/reset are only valid with action checkpoint.");
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
        reset: new ResetController(),
        timer: undefined,
        attempt: undefined,
        pendingUsage: pendingUsage(ctx.sessionManager.getBranch()),
        requestedId: undefined,
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
            : "Fresh-window resets are off/unavailable. Continue using normal pi compaction.\n"),
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
      session.attempt = { reason: "disabled" };
      if (!(await refresh(session))) {
        session.attempt = { reason: session.error ? "preference_error" : session.mode };
        return;
      }
      // Defer durable outcome writes until after compaction: changing the leaf in this hook
      // would invalidate Pi's preparation and our on-disk verification snapshot.
      const fallback = (reason: string, code: string) => {
        session.attempt = { reason: code };
        notify(ctx, `Context: ${reason} Using normal pi compaction.`, "warning");
      };
      if (event.customInstructions?.trim()) {
        session.attempt = { reason: "custom_instructions" };
        return;
      }
      if (!toolsAvailable()) {
        fallback("recall/notes are not both active.", "tools_unavailable");
        return;
      }
      if (ctx.hasPendingMessages()) {
        fallback("Queued user input is not checkpointed.", "queued_input");
        return;
      }
      const saved = latestCheckpoint(event.branchEntries);
      if (!saved) {
        fallback("No valid checkpoint.", "missing_checkpoint");
        return;
      }
      const problem = checkpointProblem(event.branchEntries, saved);
      if (problem) {
        fallback(problem, "invalid_checkpoint");
        return;
      }
      const beforeLeaf = ctx.sessionManager.getLeafId();
      if (event.branchEntries.at(-1)?.id !== beforeLeaf) {
        fallback(
          "Another handler changed the branch after compaction preparation.",
          "branch_changed",
        );
        return;
      }
      try {
        event.signal.throwIfAborted();
        await verify(
          ctx.sessionManager.getSessionFile(),
          saved.entryId,
          saved.data,
          event.branchEntries,
          event.signal,
        );
        if (!(await refresh(session))) return;
        event.signal.throwIfAborted();
        if (
          !active(session) ||
          !toolsAvailable() ||
          ctx.hasPendingMessages() ||
          ctx.sessionManager.getLeafId() !== beforeLeaf
        )
          throw new Error("Session branch or queued input changed during checkpoint validation.");
        const summary = bootstrap(saved, event.branchEntries);
        if (
          !ctx.model ||
          (Buffer.byteLength(summary) + Buffer.byteLength(ctx.getSystemPrompt())) / 3 + 1024 >
            ctx.model.contextWindow * 0.75
        )
          throw new Error("Checkpoint and system prompt leave insufficient context headroom.");
        // A real non-message entry is a legal kept boundary. It contributes no tail messages.
        const boundary = persistedAppend(ctx, WINDOW_TYPE, {
          version: 1,
          checkpointId: saved.entryId,
        });
        session.attempt = {
          reason: "verified_checkpoint",
          checkpointId: saved.entryId,
          windowId: boundary,
        };
        return {
          compaction: {
            summary,
            firstKeptEntryId: boundary,
            tokensBefore: event.preparation.tokensBefore,
            details: {
              context: { version: 1, checkpointId: saved.entryId, windowId: boundary },
              readFiles: [...event.preparation.fileOps.read],
              modifiedFiles: [
                ...new Set([
                  ...event.preparation.fileOps.written,
                  ...event.preparation.fileOps.edited,
                ]),
              ],
            },
          },
        };
      } catch (error) {
        if (event.signal.aborted) return { cancel: true };
        fallback(message(error), "verification_failed");
        return;
      }
    });
    pi.on("session_compact", (event) => {
      const session = runtime;
      if (!session) return;
      session.reset.compacted();
      const entry = event.compactionEntry;
      const details = entry.details as { context?: { checkpointId?: string } } | undefined;
      const checkpointId = details?.context?.checkpointId;
      const fresh =
        entry.fromHook === true &&
        checkpointId !== undefined &&
        checkpointId === session.attempt?.checkpointId &&
        entry.firstKeptEntryId === session.attempt?.windowId;
      record(session, "compaction", {
        outcome: fresh ? "fresh" : entry.fromHook ? "other" : "normal",
        reason: fresh
          ? "verified_checkpoint"
          : session.attempt?.checkpointId
            ? "overridden"
            : (session.attempt?.reason ?? "unknown"),
        compactionId: entry.id,
        tokensBefore: entry.tokensBefore,
        ...(fresh ? { checkpointId } : {}),
      });
      session.attempt = undefined;
      session.pendingUsage = entry.id;
      render(session);
    });
    pi.on("session_compact_failed", (event) => {
      const session = runtime;
      if (!session) return;
      record(session, event.aborted ? "cancelled" : "compaction_failed", {
        reason: event.aborted ? "compaction_aborted" : (session.attempt?.reason ?? "host_rejected"),
      });
      session.failureRecorded = true;
      session.attempt = undefined;
      if (event.aborted) {
        session.reset.cancel();
        session.requestedId = undefined;
      }
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
    pi.on("agent_settled", (_event, ctx) => {
      const session = runtime;
      if (session) {
        session.ctx = ctx;
        syncTools(session);
      }
      const pending = session?.reset.take();
      if (!session || !pending) return;
      session.ctx = ctx;
      if (ctx.hasPendingMessages()) {
        cancelRequest(session, "queued_input");
        return;
      }
      if (pending.compacted) {
        continueTask(session, CONTINUE);
        return;
      }
      if (session.mode !== "exp" || session.error) {
        continueTask(
          session,
          "Context resets were switched off or became unavailable. Continue the existing task in the current conversation without resetting.",
        );
        return;
      }
      const saved = latestCheckpoint(ctx.sessionManager.getBranch());
      if (
        !saved ||
        saved.entryId !== pending.checkpointId ||
        checkpointProblem(ctx.sessionManager.getBranch(), saved)
      ) {
        // The agent already handled newer work; do not restart a completed/steered task.
        cancelRequest(session, "newer_work");
        return;
      }
      const finish = session.reset.begin();
      session.failureRecorded = false;
      const workLeaf = () =>
        ctx.sessionManager
          .getBranch()
          .filter((entry) => !(entry.type === "custom" && entry.customType === EVENT_TYPE))
          .at(-1)?.id;
      const leaf = workLeaf();
      ctx.compact({
        onComplete: () => {
          if (!finish()) return;
          continueTask(session, CONTINUE);
        },
        onError: (error) => {
          if (!finish()) return;
          if (!active(session)) return;
          const unchanged = workLeaf() === leaf;
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
          notify(ctx, `Context reset failed: ${message(error)}`, "warning");
          if (unchanged)
            continueTask(
              session,
              "The context reset failed; the original conversation is still available. Continue the existing task. Do not request another reset until more work has been completed.",
            );
        },
      });
    });
  };
}

export default createContextExtension();
