import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  addUsage,
  cloneRun,
  emptyUsage,
  PROCEDURE_TOOLS,
  READ_ONLY_TOOLS,
  RISKY_TOOLS,
  type AgentExecutionUpdate,
  type AgentExecutor,
  type PendingApproval,
  type ProcedureDefinition,
  type ProcedureEvent,
  type ProcedureRun,
  type ProcedureTaskRun,
  type ProcedureTaskSpec,
  type ProcedureTool,
  type RunStatus,
} from "./models.ts";
import { terminalText, validateProcedureSource, validateProcedureTools } from "./security.ts";
import type { ProcedureRunStore } from "./store.ts";
import { PROCEDURE_WORKER_SOURCE } from "./worker-runtime.ts";

const MAX_TASKS_PER_RUN = 64;
const MAX_CONCURRENCY = 4;
const MAX_EVENTS = 500;
const MAX_ARTIFACTS = 30;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_TASK_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
const RUN_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const THINKING_LEVELS = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function boundedValue<T>(value: T, maximumBytes: number, label: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(serialized ?? "null", "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes / 1024} KiB.`);
  }
  return value;
}

function boundedText(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = value.slice(0, maximumBytes);
  while (Buffer.byteLength(result, "utf8") > maximumBytes) result = result.slice(0, -1);
  return `${result}\n[output truncated]`;
}

function isActive(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "paused" || status === "waiting";
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw abortError();
    if (this.active < MAX_CONCURRENCY) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolvePromise, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", aborted);
        this.active += 1;
        resolvePromise();
      };
      const aborted = () => {
        const index = this.waiters.indexOf(ready);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", aborted, { once: true });
      this.waiters.push(ready);
    });
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

function abortError(message = "Procedure stopped."): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

interface InternalRun {
  run: ProcedureRun;
  definition: ProcedureDefinition;
  source: string;
  executor: AgentExecutor;
  controller: AbortController;
  worker?: Worker;
  semaphore: Semaphore;
  paused: boolean;
  resumeWaiters: Array<() => void>;
  approval?: { value: PendingApproval; resolve: (approved: boolean) => void };
  rpcOperations: Set<Promise<unknown>>;
  completion?: Promise<void>;
  finished: boolean;
}

export interface StartProcedureOptions {
  definition: ProcedureDefinition;
  source: string;
  sourcePath: string;
  input: unknown;
  cwd: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  executor: AgentExecutor;
}

export interface ProcedureRegistryOptions {
  store: ProcedureRunStore;
  onUpdate?: (run: ProcedureRun) => void;
  onTerminal?: (run: ProcedureRun) => void;
  now?: () => Date;
}

export class ProcedureRegistry {
  private readonly runs = new Map<string, InternalRun>();
  private readonly history = new Map<string, ProcedureRun>();
  private readonly listeners = new Set<() => void>();
  private readonly store: ProcedureRunStore;
  private readonly onUpdate?: (run: ProcedureRun) => void;
  private readonly onTerminal?: (run: ProcedureRun) => void;
  private readonly now: () => Date;

  constructor(options: ProcedureRegistryOptions) {
    this.store = options.store;
    this.onUpdate = options.onUpdate;
    this.onTerminal = options.onTerminal;
    this.now = options.now ?? (() => new Date());
  }

  async restore(): Promise<void> {
    for (const loaded of await this.store.load()) {
      loaded.description ??= "";
      loaded.allowedTools ??= [...READ_ONLY_TOOLS];
      for (const task of loaded.tasks) {
        task.model ??= loaded.model;
        task.thinkingLevel ??= loaded.thinkingLevel;
      }
      if (isActive(loaded.status)) {
        loaded.status = "interrupted";
        loaded.error = "Pi exited or reloaded before this procedure completed.";
        loaded.finishedAt = this.now().toISOString();
        loaded.updatedAt = loaded.finishedAt;
        await this.store.save(loaded);
      }
      this.history.set(loaded.id, loaded);
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ProcedureRun[] {
    const current = [...this.runs.values()].map((entry) => entry.run);
    const currentIds = new Set(current.map((entry) => entry.id));
    return [...current, ...[...this.history.values()].filter((entry) => !currentIds.has(entry.id))]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRun);
  }

  get(id: string): ProcedureRun | undefined {
    const internal = this.findInternal(id);
    if (internal) return cloneRun(internal.run);
    const historical = this.findHistory(id);
    return historical ? cloneRun(historical) : undefined;
  }

  start(options: StartProcedureOptions): ProcedureRun {
    validateProcedureSource(options.source);
    boundedValue(options.input, MAX_ARTIFACT_BYTES, "Procedure input");
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const run: ProcedureRun = {
      version: 1,
      id,
      procedureName: options.definition.name,
      title: options.definition.title,
      description: options.definition.description,
      goal: options.definition.goal,
      allowedTools: [...options.definition.allowedTools],
      cwd: options.cwd,
      sourcePath: options.sourcePath,
      status: "queued",
      phase: "starting",
      createdAt: timestamp,
      updatedAt: timestamp,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      input: structuredClone(options.input),
      tasks: [],
      events: [],
      artifacts: [],
      usage: emptyUsage(),
    };
    const internal: InternalRun = {
      run,
      definition: options.definition,
      source: options.source,
      executor: options.executor,
      controller: new AbortController(),
      semaphore: new Semaphore(),
      paused: false,
      resumeWaiters: [],
      rpcOperations: new Set(),
      finished: false,
    };
    this.runs.set(id, internal);
    this.event(internal, "run", "Procedure queued.");
    internal.completion = this.execute(internal);
    void internal.completion.catch(() => undefined);
    return cloneRun(run);
  }

  pause(id: string): boolean {
    const internal = this.findInternal(id);
    if (!internal || !isActive(internal.run.status) || internal.paused) return false;
    internal.paused = true;
    if (internal.run.status !== "waiting") internal.run.status = "paused";
    this.event(internal, "run", "Scheduling paused; running agents will finish.");
    return true;
  }

  resume(id: string): boolean {
    const internal = this.findInternal(id);
    if (!internal || !internal.paused) return false;
    internal.paused = false;
    if (internal.run.status === "paused") internal.run.status = "running";
    for (const resolvePromise of internal.resumeWaiters.splice(0)) resolvePromise();
    this.event(internal, "run", "Procedure resumed.");
    return true;
  }

  approve(id: string, approved: boolean): boolean {
    const internal = this.findInternal(id);
    if (!internal?.approval) return false;
    const pending = internal.approval;
    internal.approval = undefined;
    delete internal.run.pendingApproval;
    internal.run.status = internal.paused ? "paused" : "running";
    this.event(internal, "approval", `${approved ? "Approved" : "Denied"}: ${pending.value.label}`);
    pending.resolve(approved);
    return true;
  }

  stop(id: string): boolean {
    const internal = this.findInternal(id);
    if (!internal || !isActive(internal.run.status)) return false;
    const hadApproval = Boolean(internal.approval || internal.run.pendingApproval);
    internal.approval?.resolve(false);
    internal.approval = undefined;
    delete internal.run.pendingApproval;
    if (hadApproval) this.event(internal, "approval", "Approval cancelled: run stopped.");
    else this.touch(internal);
    internal.controller.abort();
    void internal.worker?.terminate();
    return true;
  }

  async stopAll(): Promise<void> {
    for (const internal of this.runs.values()) this.stop(internal.run.id);
    await Promise.allSettled(
      [...this.runs.values()].map(async (internal) => {
        await internal.worker?.terminate();
        await internal.completion;
      }),
    );
    await this.store.flush();
  }

  private async execute(internal: InternalRun): Promise<void> {
    const runTimer = setTimeout(() => internal.controller.abort(), RUN_TIMEOUT_MS);
    try {
      internal.run.status = "running";
      internal.run.phase = "running";
      internal.run.startedAt = this.now().toISOString();
      this.event(internal, "run", "Procedure started.");
      const result = await this.executeWorker(internal);
      const unawaitedOperations = [...internal.rpcOperations];
      await Promise.allSettled(unawaitedOperations);
      if (internal.controller.signal.aborted) throw abortError();
      if (unawaitedOperations.length > 0) {
        throw new Error(
          `Procedure returned with ${unawaitedOperations.length} unawaited host operation(s). Await every $. call.`,
        );
      }
      internal.run.result = boundedValue(result, MAX_ARTIFACT_BYTES, "Procedure result");
      internal.run.status = "completed";
      internal.run.phase = "completed";
      this.event(internal, "run", "Procedure completed.");
    } catch (error) {
      const aborted = internal.controller.signal.aborted || (error as Error).name === "AbortError";
      internal.run.status = aborted ? "cancelled" : "failed";
      internal.run.phase = aborted ? "cancelled" : "failed";
      internal.run.error = terminalText(error instanceof Error ? error.message : error, 8_000);
      this.event(
        internal,
        "run",
        aborted ? "Procedure stopped." : `Procedure failed: ${internal.run.error}`,
      );
    } finally {
      clearTimeout(runTimer);
      await Promise.allSettled(internal.rpcOperations);
      internal.finished = true;
      internal.run.finishedAt = this.now().toISOString();
      this.touch(internal, true);
      internal.worker?.removeAllListeners();
      await internal.worker?.terminate().catch(() => undefined);
      this.history.set(internal.run.id, cloneRun(internal.run));
      this.runs.delete(internal.run.id);
      this.emit();
      this.onTerminal?.(cloneRun(internal.run));
    }
  }

  private executeWorker(internal: InternalRun): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(PROCEDURE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          source: internal.source,
          input: internal.run.input,
          filename: internal.run.sourcePath,
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 },
      });
      internal.worker = worker;
      let settled = false;
      const postReply = (reply: Record<string, unknown>): void => {
        if (settled) return;
        try {
          worker.postMessage(reply);
        } catch {
          // The run may have been stopped while an in-flight host operation settled.
        }
      };
      const settle = (operation: () => void) => {
        if (settled) return;
        settled = true;
        operation();
      };
      worker.on("message", (message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message)) return;
        const value = message as Record<string, unknown>;
        if (value.type === "rpc") {
          const operation = this.handleRpc(internal, value);
          internal.rpcOperations.add(operation);
          void operation.then(
            (result) => {
              internal.rpcOperations.delete(operation);
              postReply({ type: "reply", id: value.id, ok: true, value: result });
            },
            (error) => {
              internal.rpcOperations.delete(operation);
              postReply({
                type: "reply",
                id: value.id,
                ok: false,
                name: error instanceof Error ? error.name : "Error",
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        } else if (value.type === "done") {
          settle(() => resolvePromise(value.result));
        } else if (value.type === "error") {
          settle(() => reject(new Error(terminalText(value.error, 8_000))));
        }
      });
      worker.on("error", (error) => settle(() => reject(error)));
      worker.on("exit", (code) => {
        if (code !== 0)
          settle(() => reject(new Error(`Procedure worker exited with code ${code}.`)));
        else settle(() => reject(new Error("Procedure worker exited without a result.")));
      });
      internal.controller.signal.addEventListener(
        "abort",
        () => {
          void worker.terminate();
          settle(() => reject(abortError()));
        },
        { once: true },
      );
    });
  }

  private async handleRpc(
    internal: InternalRun,
    message: Record<string, unknown>,
  ): Promise<unknown> {
    if (internal.controller.signal.aborted) throw abortError();
    const method = message.method;
    const args =
      message.args && typeof message.args === "object"
        ? (message.args as Record<string, unknown>)
        : {};
    switch (method) {
      case "agent":
        return this.runAgent(internal, this.agentSpec(args));
      case "phase": {
        const name = terminalText(args.name, 120).trim();
        if (!name) throw new Error("Phase name is required.");
        internal.run.phase = name;
        this.event(internal, "phase", name);
        return undefined;
      }
      case "log": {
        const text = terminalText(args.message, 2_000);
        this.event(internal, "log", text);
        return undefined;
      }
      case "artifact": {
        if (internal.run.artifacts.length >= MAX_ARTIFACTS)
          throw new Error("Artifact limit reached.");
        const name = terminalText(args.name, 120).trim();
        if (!name) throw new Error("Artifact name is required.");
        const value = boundedValue(args.value, MAX_ARTIFACT_BYTES, `Artifact ${name}`);
        internal.run.artifacts.push({ name, value, createdAt: this.now().toISOString() });
        this.event(internal, "artifact", `Saved artifact: ${name}`);
        return value;
      }
      case "approval":
        return this.requestApproval(internal, args);
      case "sleep": {
        const ms = Number(args.ms);
        if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) {
          throw new Error("Sleep must be between 0 and 60000 ms.");
        }
        await new Promise<void>((resolvePromise, reject) => {
          const timer = setTimeout(resolvePromise, ms);
          internal.controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(abortError());
            },
            { once: true },
          );
        });
        return undefined;
      }
      default:
        throw new Error(`Unknown procedure operation: ${String(method)}`);
    }
  }

  private agentSpec(args: Record<string, unknown>): ProcedureTaskSpec {
    const id = terminalText(args.id, 120).trim();
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!id) throw new Error("Agent id is required.");
    if (!prompt) throw new Error(`Agent ${id} has an empty prompt.`);
    if (Buffer.byteLength(prompt, "utf8") > 48 * 1024) {
      throw new Error(`Agent ${id} prompt exceeds 48 KiB.`);
    }
    const rawTools = Array.isArray(args.tools) ? args.tools.map(String) : undefined;
    const retries = args.retries === undefined ? undefined : Number(args.retries);
    const timeoutMs = args.timeoutMs === undefined ? undefined : Number(args.timeoutMs);
    const model = args.model === undefined ? undefined : terminalText(args.model, 240).trim();
    if (model !== undefined && !model.includes("/")) {
      throw new Error(`Agent ${id} model must use provider/model-id syntax.`);
    }
    const thinking =
      args.thinking === undefined
        ? undefined
        : (terminalText(args.thinking, 20) as ModelThinkingLevel);
    if (thinking !== undefined && !THINKING_LEVELS.has(thinking)) {
      throw new Error(`Agent ${id} requested unsupported thinking level ${thinking}.`);
    }
    return {
      id,
      prompt,
      tools: rawTools ? validateProcedureTools(rawTools) : undefined,
      model,
      thinking,
      retries,
      timeoutMs,
    };
  }

  private async runAgent(internal: InternalRun, spec: ProcedureTaskSpec): Promise<unknown> {
    if (internal.run.tasks.length >= MAX_TASKS_PER_RUN)
      throw new Error("Procedure task limit reached.");
    const allowed = new Set(internal.definition.allowedTools);
    const tools = validateProcedureTools(spec.tools ?? READ_ONLY_TOOLS);
    for (const tool of tools) {
      if (!allowed.has(tool))
        throw new Error(`Agent ${spec.id} requested undeclared tool ${tool}.`);
    }
    const duplicateCount = internal.run.tasks.filter((entry) => entry.id === spec.id).length;
    const displayId = duplicateCount === 0 ? spec.id : `${spec.id}#${duplicateCount + 1}`;
    const task: ProcedureTaskRun = {
      id: displayId,
      callId: randomUUID(),
      prompt: spec.prompt,
      tools,
      model: spec.model ?? internal.run.model,
      thinkingLevel: spec.thinking ?? internal.run.thinkingLevel,
      status: "queued",
      attempt: 0,
      createdAt: this.now().toISOString(),
      recentTools: [],
      usage: emptyUsage(),
    };
    internal.run.tasks.push(task);
    this.event(internal, "task", `Queued ${displayId}.`, displayId);
    await this.waitUntilResumed(internal);
    const release = await internal.semaphore.acquire(internal.controller.signal);
    try {
      const risky = tools.some((tool) => RISKY_TOOLS.has(tool));
      const requestedRetries = Number.isSafeInteger(spec.retries)
        ? Math.max(0, spec.retries ?? 0)
        : 0;
      const maximumRetries = risky ? 0 : Math.min(2, requestedRetries);
      const timeoutMs = Math.min(
        MAX_TASK_TIMEOUT_MS,
        Math.max(
          1_000,
          Number.isFinite(spec.timeoutMs)
            ? (spec.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS)
            : DEFAULT_TASK_TIMEOUT_MS,
        ),
      );
      let lastError: unknown;
      for (let attempt = 1; attempt <= maximumRetries + 1; attempt += 1) {
        await this.waitUntilResumed(internal);
        task.attempt = attempt;
        task.status = "running";
        task.startedAt ??= this.now().toISOString();
        task.activity = "starting agent";
        this.event(internal, "task", `Started ${displayId} (attempt ${attempt}).`, displayId);
        const attemptController = new AbortController();
        const abortAttempt = () => attemptController.abort();
        internal.controller.signal.addEventListener("abort", abortAttempt, { once: true });
        const timer = setTimeout(() => attemptController.abort(), timeoutMs);
        try {
          const reportedUsage = emptyUsage();
          const result = await internal.executor.execute(
            {
              runId: internal.run.id,
              taskId: displayId,
              prompt: spec.prompt,
              tools,
              model: spec.model,
              thinkingLevel: spec.thinking,
            },
            {
              signal: attemptController.signal,
              onUpdate: (update) => {
                if (update.usage) addUsage(reportedUsage, update.usage);
                this.updateTask(internal, task, update);
              },
            },
          );
          const unreportedUsage = {
            input: Math.max(0, result.usage.input - reportedUsage.input),
            output: Math.max(0, result.usage.output - reportedUsage.output),
            cacheRead: Math.max(0, result.usage.cacheRead - reportedUsage.cacheRead),
            cacheWrite: Math.max(0, result.usage.cacheWrite - reportedUsage.cacheWrite),
            cost: Math.max(0, result.usage.cost - reportedUsage.cost),
            turns: Math.max(0, result.usage.turns - reportedUsage.turns),
          };
          addUsage(task.usage, unreportedUsage);
          addUsage(internal.run.usage, unreportedUsage);
          task.output = boundedText(result.text, MAX_TASK_OUTPUT_BYTES);
          task.model = result.model ?? task.model;
          task.thinkingLevel = result.thinkingLevel ?? task.thinkingLevel;
          task.status = "completed";
          task.activity = "completed";
          task.finishedAt = this.now().toISOString();
          this.event(internal, "task", `Completed ${displayId}.`, displayId);
          return {
            taskId: displayId,
            text: task.output,
            usage: structuredClone(task.usage),
          };
        } catch (error) {
          lastError = error;
          if (internal.controller.signal.aborted) throw abortError();
          if (attempt <= maximumRetries) {
            task.status = "retrying";
            task.activity = "retrying after failure";
            this.event(
              internal,
              "task",
              `Retrying ${displayId}: ${terminalText(error)}`,
              displayId,
            );
            await this.delay(250 * attempt, internal.controller.signal);
            continue;
          }
        } finally {
          clearTimeout(timer);
          internal.controller.signal.removeEventListener("abort", abortAttempt);
        }
      }
      task.status = internal.controller.signal.aborted ? "cancelled" : "failed";
      task.finishedAt = this.now().toISOString();
      task.error = terminalText(lastError instanceof Error ? lastError.message : lastError, 8_000);
      this.event(internal, "task", `Failed ${displayId}: ${task.error}`, displayId);
      throw new Error(`Agent ${displayId} failed: ${task.error}`);
    } finally {
      release();
      this.touch(internal);
    }
  }

  private updateTask(
    internal: InternalRun,
    task: ProcedureTaskRun,
    update: AgentExecutionUpdate,
  ): void {
    if (update.activity) task.activity = terminalText(update.activity, 300);
    if (update.usage) {
      addUsage(task.usage, update.usage);
      addUsage(internal.run.usage, update.usage);
    }
    if (update.tool) {
      const existing = task.recentTools.find((entry) =>
        entry.summary.startsWith(`[${update.tool!.toolCallId}]`),
      );
      const summary = `[${update.tool.toolCallId}] ${terminalText(update.tool.summary, 500)}`;
      if (existing) {
        existing.status = update.tool.status;
        existing.summary = summary;
      } else {
        task.recentTools.push({
          at: this.now().toISOString(),
          tool: terminalText(update.tool.name, 80),
          summary,
          status: update.tool.status,
        });
        if (task.recentTools.length > 20) task.recentTools.splice(0, task.recentTools.length - 20);
      }
      task.activity = `${update.tool.name}: ${terminalText(update.tool.summary, 160)}`;
    }
    this.touch(internal);
  }

  private requestApproval(internal: InternalRun, args: Record<string, unknown>): Promise<boolean> {
    if (internal.approval) throw new Error("Only one approval may be pending at a time.");
    const label = terminalText(args.label, 300).trim();
    if (!label) throw new Error("Approval label is required.");
    const details = args.details === undefined ? undefined : terminalText(args.details, 4_000);
    const value: PendingApproval = {
      requestId: randomUUID(),
      label,
      details,
      requestedAt: this.now().toISOString(),
    };
    internal.run.pendingApproval = value;
    internal.run.status = "waiting";
    return new Promise<boolean>((resolvePromise) => {
      internal.approval = { value, resolve: resolvePromise };
      this.event(internal, "approval", `Waiting for approval: ${label}`);
    });
  }

  private waitUntilResumed(internal: InternalRun): Promise<void> {
    if (!internal.paused) return Promise.resolve();
    if (internal.controller.signal.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolvePromise, reject) => {
      const resumed = () => {
        internal.controller.signal.removeEventListener("abort", aborted);
        resolvePromise();
      };
      const aborted = () => {
        const index = internal.resumeWaiters.indexOf(resumed);
        if (index >= 0) internal.resumeWaiters.splice(index, 1);
        reject(abortError());
      };
      internal.controller.signal.addEventListener("abort", aborted, { once: true });
      internal.resumeWaiters.push(resumed);
    });
  }

  private async delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(resolvePromise, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  private event(
    internal: InternalRun,
    type: ProcedureEvent["type"],
    message: string,
    taskId?: string,
  ): void {
    internal.run.events.push({
      sequence: (internal.run.events.at(-1)?.sequence ?? 0) + 1,
      at: this.now().toISOString(),
      type,
      message: terminalText(message, 2_000),
      taskId,
    });
    if (internal.run.events.length > MAX_EVENTS) {
      internal.run.events.splice(0, internal.run.events.length - MAX_EVENTS);
    }
    this.touch(internal);
  }

  private touch(internal: InternalRun, terminal = false): void {
    internal.run.updatedAt = this.now().toISOString();
    void this.store.save(internal.run).catch(() => undefined);
    this.onUpdate?.(cloneRun(internal.run));
    if (!terminal) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private findInternal(id: string): InternalRun | undefined {
    if (this.runs.has(id)) return this.runs.get(id);
    const matches = [...this.runs.values()].filter((entry) => entry.run.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private findHistory(id: string): ProcedureRun | undefined {
    if (this.history.has(id)) return this.history.get(id);
    const matches = [...this.history.values()].filter((entry) => entry.id.startsWith(id));
    return matches.length === 1 ? matches[0] : undefined;
  }
}

export function activeRuns(runs: readonly ProcedureRun[]): ProcedureRun[] {
  return runs.filter((run) => isActive(run.status));
}

export function allowedProcedureTools(): readonly ProcedureTool[] {
  return PROCEDURE_TOOLS;
}
