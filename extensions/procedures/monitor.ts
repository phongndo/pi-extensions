import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ProcedureRun, ProcedureTaskRun, RunStatus } from "./models.ts";
import { activeRuns, type ProcedureRegistry } from "./runner.ts";
import { terminalText } from "./security.ts";

type Theme = ExtensionCommandContext["ui"]["theme"];
type View = "runs" | "run" | "task";

export interface MonitorActions {
  restart?: (runId: string) => Promise<void>;
}

function statusIcon(status: RunStatus, theme: Theme): string {
  switch (status) {
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
    case "interrupted":
      return theme.fg("error", "✗");
    case "cancelled":
      return theme.fg("warning", "■");
    case "paused":
      return theme.fg("warning", "Ⅱ");
    case "waiting":
      return theme.fg("warning", "?");
    default:
      return theme.fg("accent", "●");
  }
}

function elapsed(run: ProcedureRun): string {
  const start = Date.parse(run.startedAt ?? run.createdAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`;
}

function tokens(run: ProcedureRun): number {
  return run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function taskCounts(run: ProcedureRun): string {
  const active = run.tasks.filter(
    (task) => task.status === "running" || task.status === "retrying",
  ).length;
  const done = run.tasks.filter((task) => task.status === "completed").length;
  const failed = run.tasks.filter((task) => task.status === "failed").length;
  return `${done} done${active ? ` · ${active} active` : ""}${failed ? ` · ${failed} failed` : ""}`;
}

function border(width: number, theme: Theme): string {
  return theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
}

function addWrapped(lines: string[], text: string, width: number, maximumLines = 8): void {
  lines.push(...wrapTextWithAnsi(text, Math.max(1, width)).slice(0, maximumLines));
}

function formatInspectable(value: unknown, maximum = 4_000): string {
  let serialized: string;
  try {
    serialized =
      typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    serialized = String(value);
  }
  return terminalText(serialized, maximum);
}

class MonitorComponent implements Component {
  private view: View = "runs";
  private selectedRun = 0;
  private selectedTask = 0;
  private runId?: string;
  private readonly registry: ProcedureRegistry;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly close: () => void;
  private readonly actions: MonitorActions;
  private readonly restarting = new Set<string>();

  constructor(
    registry: ProcedureRegistry,
    theme: Theme,
    keybindings: KeybindingsManager,
    requestRender: () => void,
    close: () => void,
    initialRunId?: string,
    actions: MonitorActions = {},
  ) {
    this.registry = registry;
    this.theme = theme;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.close = close;
    this.actions = actions;
    if (initialRunId) {
      const index = registry.list().findIndex((run) => run.id.startsWith(initialRunId));
      if (index >= 0) {
        this.selectedRun = index;
        this.runId = registry.list()[index]?.id;
        this.view = "run";
      }
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const lines = [border(safeWidth, this.theme)];
    if (this.view === "runs") this.renderRuns(lines, safeWidth);
    else {
      const run = this.currentRun();
      if (!run) {
        this.view = "runs";
        this.renderRuns(lines, safeWidth);
      } else if (this.view === "run") this.renderRun(lines, safeWidth, run);
      else this.renderTask(lines, safeWidth, run, run.tasks[this.selectedTask]);
    }
    lines.push(border(safeWidth, this.theme));
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    const runs = this.registry.list();
    if (this.keybindings.matches(data, "tui.select.up")) {
      if (this.view === "runs") this.selectedRun = Math.max(0, this.selectedRun - 1);
      else if (this.view === "run") this.selectedTask = Math.max(0, this.selectedTask - 1);
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      if (this.view === "runs")
        this.selectedRun = Math.min(Math.max(0, runs.length - 1), this.selectedRun + 1);
      else if (this.view === "run") {
        const run = this.currentRun();
        this.selectedTask = Math.min(
          Math.max(0, (run?.tasks.length ?? 1) - 1),
          this.selectedTask + 1,
        );
      }
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.view === "runs") {
        const run = runs[this.selectedRun];
        if (run) {
          this.runId = run.id;
          this.selectedTask = 0;
          this.view = "run";
        }
      } else if (this.view === "run" && this.currentRun()?.tasks[this.selectedTask]) {
        this.view = "task";
      }
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.view === "task") this.view = "run";
      else if (this.view === "run") this.view = "runs";
      else {
        this.close();
        return;
      }
    } else {
      this.handleAction(data);
    }
    this.requestRender();
  }

  invalidate(): void {}

  private handleAction(data: string): void {
    const run = this.currentRun();
    if (!run) return;
    if (data === "p") {
      if (run.status === "paused") this.registry.resume(run.id);
      else this.registry.pause(run.id);
    } else if (data === "x") {
      this.registry.stop(run.id);
    } else if (data === "a") {
      this.registry.approve(run.id, true);
    } else if (data === "d") {
      this.registry.approve(run.id, false);
    } else if (
      data === "r" &&
      activeRuns([run]).length === 0 &&
      !this.restarting.has(run.id) &&
      this.actions.restart
    ) {
      this.restarting.add(run.id);
      void this.actions.restart(run.id).finally(() => {
        this.restarting.delete(run.id);
        this.requestRender();
      });
    }
  }

  private currentRun(): ProcedureRun | undefined {
    if (this.runId) return this.registry.get(this.runId);
    return this.registry.list()[this.selectedRun];
  }

  private renderRuns(lines: string[], width: number): void {
    const runs = this.registry.list();
    lines.push(this.theme.fg("accent", this.theme.bold(" Procedures monitor")));
    lines.push(
      this.theme.fg(
        "dim",
        ` ${activeRuns(runs).length} active · ${runs.length} shown · enter inspect · esc close`,
      ),
    );
    if (runs.length === 0) {
      lines.push("", this.theme.fg("muted", " No procedure runs yet. Use /proc <goal>."));
      return;
    }
    lines.push("");
    for (const [index, run] of runs.slice(0, 25).entries()) {
      const selected = index === this.selectedRun;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      const safeTitle = terminalText(run.title, 160);
      const title = selected ? this.theme.fg("accent", safeTitle) : safeTitle;
      lines.push(
        `${prefix} ${statusIcon(run.status, this.theme)} ${title} ${this.theme.fg("dim", run.id.slice(0, 8))}`,
      );
      const activity = run.tasks.find((task) => task.status === "running")?.activity;
      lines.push(
        this.theme.fg(
          "muted",
          `    ${run.status} · ${run.phase} · ${taskCounts(run)} · ${formatTokens(tokens(run))} tok · ${elapsed(run)}${activity ? ` · ${terminalText(activity, Math.max(20, width - 60))}` : ""}`,
        ),
      );
    }
  }

  private renderRun(lines: string[], width: number, run: ProcedureRun): void {
    lines.push(
      ` ${statusIcon(run.status, this.theme)} ${this.theme.fg("accent", this.theme.bold(terminalText(run.title, 160)))} ${this.theme.fg("dim", run.id.slice(0, 8))}`,
    );
    lines.push(
      this.theme.fg(
        "muted",
        ` ${run.status} · ${run.phase} · ${taskCounts(run)} · ${formatTokens(tokens(run))} tok · $${run.usage.cost.toFixed(4)} · ${elapsed(run)}`,
      ),
    );
    lines.push(
      this.theme.fg(
        "dim",
        ` ↑↓ select · enter inspect · p pause/resume · x stop · r restart finished${run.pendingApproval ? " · a approve · d deny" : ""} · esc back`,
      ),
    );
    if (run.pendingApproval) {
      lines.push("", this.theme.fg("warning", ` Approval needed: ${run.pendingApproval.label}`));
      if (run.pendingApproval.details) {
        addWrapped(
          lines,
          this.theme.fg("muted", ` ${terminalText(run.pendingApproval.details, 4_000)}`),
          width - 2,
          4,
        );
      }
    }
    lines.push("", this.theme.fg("muted", " Tasks"));
    if (run.tasks.length === 0)
      lines.push(this.theme.fg("dim", "   Waiting for the script to schedule work."));
    for (const [index, task] of run.tasks.slice(0, 30).entries()) {
      const selected = index === this.selectedTask;
      const prefix = selected ? this.theme.fg("accent", ">") : " ";
      const activity = task.activity
        ? ` · ${terminalText(task.activity, Math.max(20, width - 55))}`
        : "";
      lines.push(
        `${prefix} ${task.status === "completed" ? this.theme.fg("success", "✓") : task.status === "failed" ? this.theme.fg("error", "✗") : this.theme.fg("warning", "●")} ${selected ? this.theme.fg("accent", task.id) : task.id} ${this.theme.fg("dim", `${task.status} · ${terminalText(task.model, 120)}:${task.thinkingLevel} · attempt ${task.attempt}${activity}`)}`,
      );
    }
    if (run.artifacts.length > 0) {
      lines.push("", this.theme.fg("muted", " Artifacts"));
      for (const artifact of run.artifacts.slice(-12)) {
        lines.push(
          this.theme.fg(
            "dim",
            `  ${terminalText(artifact.name, 80)} · ${artifact.createdAt.slice(11, 19)}`,
          ),
        );
        addWrapped(lines, `   ${formatInspectable(artifact.value, 4_000)}`, width - 2, 4);
      }
    }
    if (run.result !== undefined) {
      lines.push("", this.theme.fg("muted", " Final result"));
      addWrapped(lines, `  ${formatInspectable(run.result, 16_000)}`, width - 2, 12);
    }
    const events = run.events.slice(-6);
    if (events.length > 0) {
      lines.push("", this.theme.fg("muted", " Recent events"));
      for (const event of events) {
        lines.push(this.theme.fg("dim", `  ${event.at.slice(11, 19)} ${event.message}`));
      }
    }
    if (run.error) {
      lines.push("", this.theme.fg("error", ` Error: ${terminalText(run.error, width * 3)}`));
    }
  }

  private renderTask(
    lines: string[],
    width: number,
    run: ProcedureRun,
    task: ProcedureTaskRun | undefined,
  ): void {
    if (!task) {
      this.view = "run";
      this.renderRun(lines, width, run);
      return;
    }
    lines.push(
      ` ${this.theme.fg("accent", this.theme.bold(task.id))} ${this.theme.fg("muted", `${task.status} · ${terminalText(task.model, 160)} · thinking ${task.thinkingLevel} · attempt ${task.attempt} · tools ${task.tools.join(", ")}`)}`,
    );
    lines.push(this.theme.fg("dim", " esc back"), "", this.theme.fg("muted", " Assignment"));
    addWrapped(lines, `  ${terminalText(task.prompt, 48 * 1_024)}`, width - 2, 10);
    if (task.activity) lines.push("", this.theme.fg("warning", ` Current: ${task.activity}`));
    if (task.recentTools.length > 0) {
      lines.push("", this.theme.fg("muted", " Recent tool activity"));
      for (const activity of task.recentTools.slice(-12)) {
        const icon =
          activity.status === "completed" ? "✓" : activity.status === "failed" ? "✗" : "●";
        lines.push(
          this.theme.fg(
            activity.status === "failed"
              ? "error"
              : activity.status === "running"
                ? "warning"
                : "dim",
            `  ${icon} ${activity.tool} ${activity.summary.replace(/^\[[^\]]+\]\s*/, "")}`,
          ),
        );
      }
    }
    const usage = task.usage;
    lines.push(
      "",
      this.theme.fg(
        "dim",
        ` Usage: ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)} $${usage.cost.toFixed(4)}`,
      ),
    );
    if (task.error) {
      lines.push("", this.theme.fg("error", " Error"));
      addWrapped(
        lines,
        this.theme.fg("error", `  ${terminalText(task.error, 8_000)}`),
        width - 2,
        8,
      );
    } else if (task.output) {
      lines.push("", this.theme.fg("muted", " Result"));
      addWrapped(lines, `  ${terminalText(task.output, 64 * 1_024)}`, width - 2, 12);
    }
  }
}

export async function showMonitor(
  ctx: ExtensionCommandContext,
  registry: ProcedureRegistry,
  initialRunId?: string,
  actions: MonitorActions = {},
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    let unsubscribe = () => {};
    const close = () => {
      unsubscribe();
      done(undefined);
    };
    const component = new MonitorComponent(
      registry,
      theme,
      keybindings,
      () => tui.requestRender(),
      close,
      initialRunId,
      actions,
    );
    unsubscribe = registry.subscribe(() => tui.requestRender());
    return component;
  });
}

interface AuthorEnvelope<T> {
  result?: T;
  error?: unknown;
}

class AuthorProgress implements Component {
  readonly controller = new AbortController();
  private activity = "starting isolated procedure author";
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;

  constructor(theme: Theme, keybindings: KeybindingsManager, requestRender: () => void) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
  }

  setActivity(value: string): void {
    this.activity = terminalText(value, 300);
    this.requestRender();
  }

  render(width: number): string[] {
    return [
      border(width, this.theme),
      truncateToWidth(
        this.theme.fg(
          "accent",
          ` Working... · ${this.controller.signal.aborted ? "stopping procedure author" : this.activity}`,
        ),
        width,
      ),
      this.theme.fg("dim", " esc stop"),
      border(width, this.theme),
    ];
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel") && !this.controller.signal.aborted) {
      this.controller.abort();
      this.requestRender();
    }
  }

  invalidate(): void {}
}

export async function showAuthoringProgress<T>(
  ctx: ExtensionCommandContext,
  run: (signal: AbortSignal, activity: (value: string) => void) => Promise<T>,
): Promise<T> {
  const envelope = await ctx.ui.custom<AuthorEnvelope<T>>((tui, theme, keybindings, done) => {
    const component = new AuthorProgress(theme, keybindings, () => tui.requestRender());
    void run(component.controller.signal, (value) => component.setActivity(value))
      .then((result) => done({ result }))
      .catch((error) => done({ error }));
    return component;
  });
  if (envelope.error) throw envelope.error;
  if (envelope.result === undefined) throw new Error("Procedure author closed without a result.");
  return envelope.result;
}
