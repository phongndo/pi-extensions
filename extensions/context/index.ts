import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recall } from "./model.ts";
import { renderRecallCall, renderRecallResult } from "./render.ts";
import { GUIDE, RECALL_DESCRIPTION } from "./guidance.ts";
import { withEvidenceIds } from "./provenance.ts";
import {
  EVENT_TYPE,
  IMPLEMENTATION_VERSION,
  pendingDiagnostics,
  type Diagnostic,
  type DiagnosticEvent,
} from "./diagnostics.ts";

interface Runtime {
  ctx: ExtensionContext;
  diagnosticError: boolean;
}

/** Pi owns compaction and tool selection. Recall never changes either policy. */
export default function contextExtension(pi: ExtensionAPI): void {
  let runtime: Runtime | undefined;
  const available = (ctx: ExtensionContext) =>
    runtime?.ctx.sessionManager === ctx.sessionManager && pi.getActiveTools().includes("recall");

  function record(session: Runtime, event: DiagnosticEvent): boolean {
    if (runtime !== session) return false;
    try {
      pi.appendEntry(EVENT_TYPE, {
        version: 1,
        implementation: IMPLEMENTATION_VERSION,
        ...event,
      } satisfies Diagnostic);
      return true;
    } catch {
      if (!session.diagnosticError && session.ctx.hasUI)
        session.ctx.ui.notify("Context diagnostics could not be saved.", "warning");
      session.diagnosticError = true;
      return false;
    }
  }

  function flushDiagnostics(ctx: ExtensionContext) {
    const session = runtime;
    if (!session || session.ctx.sessionManager !== ctx.sessionManager) return;
    for (const event of pendingDiagnostics(ctx.sessionManager.getBranch())) {
      // Retry from the same persisted evidence at the next lifecycle observation.
      if (!record(session, event)) break;
    }
  }

  pi.registerTool({
    name: "recall",
    label: "Recall",
    renderCall: renderRecallCall,
    renderResult: (result, options, theme, context) =>
      renderRecallResult(result, options, theme, context.isError),
    description: RECALL_DESCRIPTION,
    promptSnippet: "Recall original session evidence after compaction",
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
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!available(ctx))
        throw new Error(
          "Recall is unavailable outside an active session or when excluded by the caller.",
        );
      const result = recall(ctx.sessionManager.getBranch(), params as Parameters<typeof recall>[1]);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    runtime = {
      ctx,
      diagnosticError: false,
    };
    flushDiagnostics(ctx);
  });
  pi.on("session_shutdown", () => {
    runtime = undefined;
  });
  pi.on("session_tree", (_event, ctx) => {
    if (runtime) {
      runtime.ctx = ctx;
      flushDiagnostics(ctx);
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (available(ctx)) return { systemPrompt: event.systemPrompt + GUIDE };
  });
  pi.on("context", (event, ctx) => {
    if (!available(ctx)) return;
    const messages = withEvidenceIds(event.messages, ctx.sessionManager.getBranch());
    return messages.some((message, i) => message !== event.messages[i]) ? { messages } : undefined;
  });

  // These events only trigger writes; persisted ancestry determines what is measured.
  pi.on("session_compact", (_event, ctx) => flushDiagnostics(ctx));
  pi.on("turn_end", (_event, ctx) => flushDiagnostics(ctx));
  pi.on("session_compact_failed", (event, ctx) => {
    if (runtime?.ctx.sessionManager === ctx.sessionManager)
      record(
        runtime,
        event.aborted
          ? { event: "cancelled", reason: "compaction_aborted" }
          : { event: "compaction_failed", reason: "host_rejected" },
      );
  });
}
