import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const PROCEDURE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

export const PROCEDURE_MODEL_ALLOWLIST = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
  "xai/grok-4.5",
] as const;
export const PROCEDURE_DEFAULT_MODEL = PROCEDURE_MODEL_ALLOWLIST[0];
export type ProcedureTool = (typeof PROCEDURE_TOOLS)[number];

export const READ_ONLY_TOOLS: ProcedureTool[] = ["read", "grep", "find", "ls"];
export const RISKY_TOOLS = new Set<ProcedureTool>(["edit", "write", "bash"]);

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type TaskStatus = "queued" | "running" | "retrying" | "completed" | "failed" | "cancelled";

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface ProcedureDefinition {
  version: 1;
  name: string;
  title: string;
  description: string;
  goal: string;
  sourceFile: string;
  allowedTools: ProcedureTool[];
  createdAt: string;
}

export interface AuthoredProcedure {
  name: string;
  title: string;
  description: string;
  source: string;
  requiredTools: ProcedureTool[];
}

export interface ProcedureModelChoice {
  reference: string;
  name: string;
  thinkingLevels: ModelThinkingLevel[];
  pinnedThinking?: ModelThinkingLevel;
  contextWindow: number;
  maxOutputTokens: number;
  input: string[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  current: boolean;
}

export interface ProcedureTaskSpec {
  id: string;
  prompt: string;
  tools?: ProcedureTool[];
  model?: string;
  thinking?: ModelThinkingLevel;
  retries?: number;
  timeoutMs?: number;
}

export interface ToolActivity {
  at: string;
  tool: string;
  summary: string;
  status: "running" | "completed" | "failed";
}

export interface ProcedureTaskRun {
  id: string;
  callId: string;
  prompt: string;
  tools: ProcedureTool[];
  model: string;
  thinkingLevel: ModelThinkingLevel;
  status: TaskStatus;
  attempt: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  activity?: string;
  recentTools: ToolActivity[];
  usage: UsageSummary;
  output?: string;
  error?: string;
}

export interface ProcedureEvent {
  sequence: number;
  at: string;
  type: "run" | "phase" | "task" | "tool" | "log" | "approval" | "artifact";
  message: string;
  taskId?: string;
}

export interface PendingApproval {
  requestId: string;
  label: string;
  details?: string;
  requestedAt: string;
}

export interface ProcedureArtifact {
  name: string;
  value: unknown;
  createdAt: string;
}

export interface ProcedureRun {
  version: 1;
  id: string;
  procedureName: string;
  title: string;
  description: string;
  goal: string;
  allowedTools: ProcedureTool[];
  cwd: string;
  sourcePath: string;
  status: RunStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  input: unknown;
  tasks: ProcedureTaskRun[];
  events: ProcedureEvent[];
  artifacts: ProcedureArtifact[];
  usage: UsageSummary;
  pendingApproval?: PendingApproval;
  result?: unknown;
  error?: string;
}

export interface AgentExecutionUpdate {
  activity?: string;
  tool?: {
    toolCallId: string;
    name: string;
    summary: string;
    status: "running" | "completed" | "failed";
  };
  usage?: UsageSummary;
}

export interface AgentExecutionResult {
  text: string;
  usage: UsageSummary;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface AgentExecutor {
  execute(
    request: {
      runId: string;
      taskId: string;
      prompt: string;
      tools: ProcedureTool[];
      model?: string;
      thinkingLevel?: ModelThinkingLevel;
    },
    options: {
      signal: AbortSignal;
      onUpdate: (update: AgentExecutionUpdate) => void;
    },
  ): Promise<AgentExecutionResult>;
}

export function emptyUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(target: UsageSummary, addition: UsageSummary): void {
  target.input += addition.input;
  target.output += addition.output;
  target.cacheRead += addition.cacheRead;
  target.cacheWrite += addition.cacheWrite;
  target.cost += addition.cost;
  target.turns += addition.turns;
}

export function cloneRun(run: ProcedureRun): ProcedureRun {
  return structuredClone(run);
}
