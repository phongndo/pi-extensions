import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  registerProcedureCommands,
  RUN_ENTRY_TYPE,
  runSummary,
  type ProcedureService,
} from "./command.ts";
import type { ProcedureRun } from "./models.ts";
import { activeRuns, ProcedureRegistry } from "./runner.ts";
import { terminalText } from "./security.ts";
import { ProcedureDefinitionStore, ProcedureRunStore } from "./store.ts";

export function refreshVisibility(ctx: ExtensionContext, service: ProcedureService): void {
  const running = activeRuns(service.registry.list());
  if (running.length === 0) {
    ctx.ui.setStatus("procedures", undefined);
    ctx.ui.setWidget("procedures", undefined);
    return;
  }
  const waitingRuns = running.filter((run) => run.status === "waiting");
  const working = running.reduce(
    (count, run) =>
      count +
      run.tasks.filter((task) => task.status === "running" || task.status === "retrying").length,
    0,
  );
  ctx.ui.setStatus(
    "procedures",
    ctx.ui.theme.fg(
      waitingRuns.length > 0 ? "warning" : "accent",
      `proc ${running.length}${working ? ` · ${working} working` : ""}${waitingRuns.length ? ` · ${waitingRuns.length} waiting` : ""}`,
    ),
  );

  // Normal background work stays in the footer. Reserve below-editor space only for an
  // actionable approval so procedures do not turn the main chat into a live log pane.
  const waiting = waitingRuns[0];
  if (!waiting) {
    ctx.ui.setWidget("procedures", undefined);
    return;
  }
  ctx.ui.setWidget(
    "procedures",
    (_tui, theme) =>
      new Text(
        `${theme.fg("warning", "?")} ${theme.fg("muted", waiting.id.slice(0, 8))} ${terminalText(waiting.pendingApproval?.label ?? waiting.title, 100)} ${theme.fg("dim", `· /monitor ${waiting.id.slice(0, 8)} to decide`)}`,
        0,
        0,
      ),
    { placement: "belowEditor" },
  );
}

function terminalNotice(run: ProcedureRun): string {
  const completed = run.tasks.filter((task) => task.status === "completed").length;
  const tokens = run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
  return `${run.title}: ${run.status} · ${completed}/${run.tasks.length} tasks · ${tokens} tokens${run.error ? ` · ${terminalText(run.error, 180)}` : ""}`;
}

export default function proceduresExtension(pi: ExtensionAPI): void {
  let service: ProcedureService | undefined;
  let currentContext: ExtensionContext | undefined;
  let shuttingDown = false;
  let unsubscribe: (() => void) | undefined;

  pi.registerEntryRenderer(RUN_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as ReturnType<typeof runSummary>;
    const status = String(data.status ?? "unknown");
    const icon =
      status === "completed"
        ? theme.fg("success", "✓")
        : status === "failed" || status === "interrupted"
          ? theme.fg("error", "✗")
          : status === "cancelled"
            ? theme.fg("warning", "■")
            : theme.fg("accent", "●");
    const text = `${icon} ${theme.fg("muted", terminalText(data.id ?? "", 40).slice(0, 8))} ${theme.fg("accent", terminalText(data.title ?? "Procedure", 120))} ${theme.fg("dim", `· ${terminalText(status, 40)} · ${terminalText(data.phase ?? "", 80)} · ${String(data.tasks ?? 0)} tasks${data.error ? ` · ${terminalText(data.error, 140)}` : ""}`)}`;
    return new Text(text, 1, 0);
  });

  registerProcedureCommands(pi, () => service);

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    currentContext = ctx;
    const runStore = new ProcedureRunStore(ctx.cwd, getAgentDir());
    const registry = new ProcedureRegistry({
      store: runStore,
      onUpdate: (run) => {
        pi.events.emit("procedures:update", runSummary(run));
      },
      onTerminal: (run) => {
        pi.events.emit("procedures:terminal", runSummary(run));
        if (!shuttingDown) pi.appendEntry(RUN_ENTRY_TYPE, runSummary(run));
        if (!shuttingDown && currentContext?.hasUI) {
          currentContext.ui.notify(
            terminalNotice(run),
            run.status === "completed" ? "info" : run.status === "cancelled" ? "warning" : "error",
          );
        }
      },
    });
    service = {
      definitions: new ProcedureDefinitionStore(ctx.cwd),
      runs: runStore,
      registry,
    };
    await registry.restore();
    unsubscribe = registry.subscribe(() => {
      if (currentContext && service) refreshVisibility(currentContext, service);
    });
    refreshVisibility(ctx, service);
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (service) await service.registry.stopAll();
    if (currentContext) {
      currentContext.ui.setStatus("procedures", undefined);
      currentContext.ui.setWidget("procedures", undefined);
    }
    currentContext = undefined;
    service = undefined;
  });
}
