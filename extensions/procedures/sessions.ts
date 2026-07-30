import {
  clampThinkingLevel,
  type Api,
  type AuthResult,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type ModelThinkingLevel,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentExecutionResult, AgentExecutor, ProcedureTool, UsageSummary } from "./models.ts";
import { addUsage, emptyUsage } from "./models.ts";
import { scopedProjectPath, terminalText } from "./security.ts";

export interface ProcedureContextFile {
  path: string;
  content: string;
}

class EffectiveCredentialStore implements CredentialStore {
  private readonly credential: Credential | undefined;
  private readonly providerId: string;

  constructor(providerId: string, auth: AuthResult | undefined) {
    this.providerId = providerId;
    this.credential =
      auth?.auth.apiKey || auth?.env
        ? { type: "api_key", key: auth.auth.apiKey, env: auth.env }
        : undefined;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return update(providerId === this.providerId ? this.credential : undefined);
  }

  async delete(_providerId: string): Promise<void> {}
}

function providerWithEffectiveAuth(
  provider: Provider,
  effectiveAuth: AuthResult | undefined,
): Provider {
  if (!effectiveAuth) return provider;
  const source = effectiveAuth.source ?? "outer Pi session";
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    auth: {
      apiKey: {
        name: `${provider.name} transferred authentication`,
        check: async () => ({ type: "api_key", source }),
        resolve: async () => effectiveAuth,
      },
    },
    getModels: () =>
      provider
        .getModels()
        .map((model) =>
          effectiveAuth.auth.baseUrl ? { ...model, baseUrl: effectiveAuth.auth.baseUrl } : model,
        ),
    refreshModels: provider.refreshModels
      ? (context) => provider.refreshModels!(context)
      : undefined,
    filterModels: provider.filterModels
      ? (models, credential) => provider.filterModels!(models, credential)
      : undefined,
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
  };
}

export interface ProcedureModelEnvironment {
  runtime: ModelRuntime;
  model: Model<Api>;
}

function stoppedError(): Error {
  return Object.assign(new Error("Procedure creation stopped."), { name: "AbortError" });
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw stoppedError();
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(stoppedError());
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolvePromise, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export async function createProcedureModelEnvironment(
  registry: ModelRegistry,
  selected: Model<Api> | undefined,
  signal?: AbortSignal,
): Promise<ProcedureModelEnvironment> {
  if (!selected) throw new Error("Select a model before creating a procedure.");
  if (signal?.aborted) throw stoppedError();
  const effectiveAuth = await abortable(registry.getProviderAuth(selected.provider), signal);
  if (!effectiveAuth) {
    throw new Error(`No usable authentication for ${selected.provider}/${selected.id}.`);
  }
  const runtime = await ModelRuntime.create({
    credentials: new EffectiveCredentialStore(selected.provider, effectiveAuth),
  });
  const provider = registry.getProvider(selected.provider);
  if (!provider) throw new Error(`Provider ${selected.provider} is unavailable.`);
  runtime.registerNativeProvider(providerWithEffectiveAuth(provider, effectiveAuth));
  await runtime.refresh({ allowNetwork: false, signal });
  const model = runtime.getModel(selected.provider, selected.id);
  if (!model)
    throw new Error(
      `Model ${selected.provider}/${selected.id} is unavailable to procedure agents.`,
    );
  if (!(await runtime.getAuth(model))) {
    throw new Error(`Could not transfer authentication for ${selected.provider}/${selected.id}.`);
  }
  return { runtime, model };
}

function wrapPathTool(
  root: string,
  definition: ToolDefinition<any, any, any>,
  mutation = false,
): ToolDefinition<any, any, any> {
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const parameterObject =
        params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const input = parameterObject as { path?: unknown };
      const optionalPath =
        definition.name === "grep" || definition.name === "find" || definition.name === "ls";
      if (typeof input.path !== "string" && !optionalPath) {
        throw new Error(`${definition.name} requires a path.`);
      }
      const path = await scopedProjectPath(
        root,
        typeof input.path === "string" ? input.path : ".",
        { mutation },
      );
      return definition.execute(
        toolCallId,
        { ...parameterObject, path },
        signal,
        onUpdate,
        context,
      );
    },
  };
}

function scopedTools(
  root: string,
  tools: readonly ProcedureTool[],
): ToolDefinition<any, any, any>[] {
  const requested = new Set(tools);
  const definitions: ToolDefinition<any, any, any>[] = [];
  if (requested.has("read")) definitions.push(wrapPathTool(root, createReadToolDefinition(root)));
  if (requested.has("grep")) definitions.push(wrapPathTool(root, createGrepToolDefinition(root)));
  if (requested.has("find")) definitions.push(wrapPathTool(root, createFindToolDefinition(root)));
  if (requested.has("ls")) definitions.push(wrapPathTool(root, createLsToolDefinition(root)));
  if (requested.has("edit"))
    definitions.push(wrapPathTool(root, createEditToolDefinition(root), true));
  if (requested.has("write"))
    definitions.push(wrapPathTool(root, createWriteToolDefinition(root), true));
  return definitions;
}

async function createRoleSession(options: {
  cwd: string;
  runtime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  systemPrompt: string;
  tools: ProcedureTool[];
  customTools?: ToolDefinition<any, any, any>[];
  customToolNames?: string[];
  contextFiles: ProcedureContextFile[];
}): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: options.contextFiles }),
  });
  await loader.reload();
  const activeTools = [...options.tools, ...(options.customToolNames ?? [])];
  const { session } = await createAgentSession({
    cwd: options.cwd,
    modelRuntime: options.runtime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: activeTools,
    customTools: [...scopedTools(options.cwd, options.tools), ...(options.customTools ?? [])],
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.inMemory(options.cwd),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    session.setActiveToolsByName(activeTools);
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

async function disposeSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

function addRawUsage(target: UsageSummary, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  target.input += typeof usage.input === "number" ? usage.input : 0;
  target.output += typeof usage.output === "number" ? usage.output : 0;
  target.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  target.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  if (usage.cost && typeof usage.cost === "object") {
    const total = (usage.cost as Record<string, unknown>).total;
    target.cost += typeof total === "number" ? total : 0;
  }
}

function finalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      !message ||
      typeof message !== "object" ||
      !("role" in message) ||
      message.role !== "assistant"
    )
      continue;
    if (!("content" in message) || !Array.isArray(message.content)) continue;
    const texts = message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          Boolean(part) &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part,
      )
      .map((part) => part.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

function summarizeTool(name: string, args: unknown): string {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (name === "bash") return terminalText(input.command ?? "shell command", 180).split("\n")[0]!;
  if (name === "grep")
    return `${terminalText(input.pattern ?? "", 80)} in ${terminalText(input.path ?? ".", 120)}`;
  if ("path" in input) return terminalText(input.path, 180);
  return terminalText(JSON.stringify(input), 180);
}

interface ProcedureModelPolicy {
  thinkingLevels: readonly ModelThinkingLevel[];
  pinnedThinking?: ModelThinkingLevel;
}

export class PiAgentExecutor implements AgentExecutor {
  private readonly options: {
    cwd: string;
    runtime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel: ModelThinkingLevel;
    contextFiles: ProcedureContextFile[];
    modelRegistry: ModelRegistry;
    availableModels: ReadonlyMap<string, ProcedureModelPolicy>;
  };
  private readonly environments = new Map<string, Promise<ProcedureModelEnvironment>>();

  constructor(options: {
    cwd: string;
    runtime: ModelRuntime;
    model: Model<Api>;
    thinkingLevel: ModelThinkingLevel;
    contextFiles: ProcedureContextFile[];
    modelRegistry: ModelRegistry;
    availableModels: ReadonlyMap<string, ProcedureModelPolicy>;
  }) {
    this.options = options;
    this.environments.set(
      `${options.model.provider}/${options.model.id}`,
      Promise.resolve({ runtime: options.runtime, model: options.model }),
    );
  }

  private environment(reference?: string): Promise<ProcedureModelEnvironment> {
    const selected = reference ?? `${this.options.model.provider}/${this.options.model.id}`;
    if (!this.options.availableModels.has(selected)) {
      throw new Error(
        `Procedure agent requested unavailable or out-of-scope model ${selected}. Regenerate the procedure or select an available model.`,
      );
    }
    const cached = this.environments.get(selected);
    if (cached) return cached;
    const separator = selected.indexOf("/");
    const provider = selected.slice(0, separator);
    const modelId = selected.slice(separator + 1);
    const model = this.options.modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Procedure model ${selected} is no longer available.`);
    const environment = createProcedureModelEnvironment(this.options.modelRegistry, model);
    this.environments.set(selected, environment);
    void environment.catch(() => {
      if (this.environments.get(selected) === environment) this.environments.delete(selected);
    });
    return environment;
  }

  async execute(
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
      onUpdate: Parameters<AgentExecutor["execute"]>[1]["onUpdate"];
    },
  ): Promise<AgentExecutionResult> {
    const selectedReference =
      request.model ?? `${this.options.model.provider}/${this.options.model.id}`;
    const modelPolicy = this.options.availableModels.get(selectedReference);
    if (!modelPolicy) {
      throw new Error(`Procedure model ${selectedReference} is unavailable or out of scope.`);
    }
    if (request.thinkingLevel && !modelPolicy.thinkingLevels.includes(request.thinkingLevel)) {
      throw new Error(
        `Procedure model ${selectedReference} does not allow thinking level ${request.thinkingLevel} in this session. Allowed: ${modelPolicy.thinkingLevels.join(", ")}.`,
      );
    }
    const environment = await this.environment(selectedReference);
    const thinkingLevel = clampThinkingLevel(
      environment.model,
      request.thinkingLevel ?? modelPolicy.pinnedThinking ?? this.options.thinkingLevel,
    );
    const session = await createRoleSession({
      cwd: this.options.cwd,
      runtime: environment.runtime,
      model: environment.model,
      thinkingLevel,
      contextFiles: this.options.contextFiles,
      systemPrompt: [
        "You are an isolated worker in a Pi procedure.",
        "Complete only the assigned task. Inspect the environment for ground truth and use the available tools as needed.",
        "Do not spawn or coordinate other agents. Stay inside the project directory.",
        "Return a concise but complete result for the procedure script to consume.",
        `Run: ${request.runId}; task: ${request.taskId}; model: ${environment.model.provider}/${environment.model.id}; thinking: ${thinkingLevel}.`,
      ].join("\n"),
      tools: request.tools,
    });
    const messages: unknown[] = [];
    const usage = emptyUsage();
    const toolSummaries = new Map<string, string>();
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        const summary = summarizeTool(event.toolName, event.args);
        toolSummaries.set(event.toolCallId, summary);
        options.onUpdate({
          activity: `using ${event.toolName}`,
          tool: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            summary,
            status: "running",
          },
        });
      } else if (event.type === "tool_execution_end") {
        options.onUpdate({
          tool: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            summary: toolSummaries.get(event.toolCallId) ?? event.toolName,
            status: event.isError ? "failed" : "completed",
          },
        });
      } else if (event.type === "message_end") {
        messages.push(event.message);
        if (event.message.role === "assistant") {
          const addition = emptyUsage();
          addition.turns = 1;
          addRawUsage(addition, event.message.usage);
          addUsage(usage, addition);
          options.onUpdate({ activity: "processing agent response", usage: addition });
        }
      } else if (event.type === "compaction_end" && event.result?.usage) {
        // Compaction rewrites session messages; provider usage is only on this event.
        const addition = emptyUsage();
        addition.turns = 1;
        addRawUsage(addition, event.result.usage);
        addUsage(usage, addition);
        options.onUpdate({ activity: "compacting context", usage: addition });
      } else if (event.type === "summarization_retry_attempt_start") {
        // Failed summarization attempts may not expose token usage, but they are model turns.
        const addition = emptyUsage();
        addition.turns = 1;
        addUsage(usage, addition);
        options.onUpdate({ activity: "retrying summarization", usage: addition });
      }
    });
    const abort = () => {
      void session.abort().catch(() => undefined);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    try {
      if (options.signal.aborted)
        throw Object.assign(new Error("Agent task stopped."), { name: "AbortError" });
      await session.prompt(request.prompt, {
        expandPromptTemplates: false,
        source: "extension",
      });
      if (options.signal.aborted)
        throw Object.assign(new Error("Agent task stopped."), { name: "AbortError" });
      const text = finalAssistantText(messages);
      if (!text) throw new Error("Procedure agent returned no text result.");
      return {
        text,
        usage,
        model: `${environment.model.provider}/${environment.model.id}`,
        thinkingLevel,
      };
    } finally {
      unsubscribe();
      options.signal.removeEventListener("abort", abort);
      await disposeSession(session);
    }
  }
}

export { createRoleSession, disposeSession, finalAssistantText };
