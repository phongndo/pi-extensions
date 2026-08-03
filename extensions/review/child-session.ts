import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
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
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRegistry,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelReference,
  ResolvedRoleModel,
  ReviewLoopSettings,
  UsageSummary,
} from "./models.ts";
import { addUsage, emptyUsage, formatModelReference } from "./models.ts";

export interface TrustedContextFile {
  path: string;
  content: string;
}

type SettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

function scopedInMemorySettingsManager(
  globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
  projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
  projectTrusted: boolean,
): SettingsManager {
  const documents: Record<"global" | "project", string | undefined> = {
    global: JSON.stringify(globalSettings),
    project: JSON.stringify(projectSettings),
  };
  const storage: SettingsStorage = {
    withLock(scope, update) {
      const next = update(documents[scope]);
      if (next !== undefined) documents[scope] = next;
    },
  };
  return SettingsManager.fromStorage(storage, { projectTrusted });
}

function childSettingsManager(
  cwd: string,
  agentDir: string,
  projectTrusted: boolean,
): SettingsManager {
  const files = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const errors = files.drainErrors();
  if (errors.length > 0) {
    throw new Error(
      `Could not load Pi settings for review-loop child extensions: ${errors.map((entry) => entry.error.message).join("; ")}`,
    );
  }
  return scopedInMemorySettingsManager(
    files.getGlobalSettings(),
    projectTrusted ? files.getProjectSettings() : {},
    projectTrusted,
  );
}

export interface ChildSessionOptions {
  cwd: string;
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  systemPrompt: string;
  tools: string[];
  customTools: ToolDefinition<any, any, any>[];
  contextFiles: TrustedContextFile[];
  projectTrusted: boolean;
  additionalExtensionPaths?: string[];
  extensionsEnabled?: boolean;
  discoverExtensions?: boolean;
  agentDir?: string;
}

/**
 * Create an in-memory role session. Reviewers may inherit normal user extensions while keeping
 * project trust disabled; fixers disable extensions. Role-model providers have already been copied
 * from the outer runtime.
 */
export async function createChildSession(options: ChildSessionOptions): Promise<AgentSession> {
  // Keep global and project documents separate so package/resource paths retain their normal
  // agent-directory and <cwd>/.pi bases without allowing writes to outer-session settings.
  const agentDir = options.agentDir ?? getAgentDir();
  const extensionsEnabled = options.extensionsEnabled ?? true;
  const discoverExtensions = options.discoverExtensions ?? true;
  const settingsManager = childSettingsManager(
    options.cwd,
    agentDir,
    options.projectTrusted && extensionsEnabled,
  );
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionsEnabled ? options.additionalExtensionPaths : [],
    noExtensions: !extensionsEnabled || !discoverExtensions,
    // Load all configured extensions as requested, but do not recursively add prompt
    // templates or skills to these tightly scoped role prompts.
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: options.contextFiles }),
  });
  const reload: ResourceLoader["reload"] = async (reloadOptions) => {
    await loader.reload(reloadOptions);
    const extensionErrors = loader.getExtensions().errors;
    if (extensionErrors.length > 0) {
      throw new Error(
        `Could not load review-loop child extensions: ${extensionErrors
          .map((entry) => `${entry.path}: ${entry.error}`)
          .join("; ")}`,
      );
    }
  };
  await reload();
  const roleLoader: ResourceLoader = {
    getExtensions: () => loader.getExtensions(),
    // CLI extension packages can also bundle skills and prompt templates. Keep extensions/hooks,
    // but never expose those instruction-bearing resources to tightly scoped role prompts.
    getSkills: () => ({ skills: [], diagnostics: loader.getSkills().diagnostics }),
    getPrompts: () => ({ prompts: [], diagnostics: loader.getPrompts().diagnostics }),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    // Extensions run normally, but their optional resource contributions do not
    // widen the role prompt with skills/templates after session_start.
    extendResources: () => undefined,
    reload,
  };
  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools,
    customTools: options.customTools,
    resourceLoader: roleLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(options.cwd),
  });
  try {
    // Give loaded extensions their normal startup lifecycle while keeping UI calls
    // non-interactive inside the nested role session.
    await session.bindExtensions({ mode: "print" });
    const roleModel = options.modelRuntime.getModel(options.model.provider, options.model.id);
    if (!roleModel) {
      throw new Error(
        `Role model disappeared after child extensions loaded: ${options.model.provider}/${options.model.id}.`,
      );
    }
    if (session.model?.provider !== roleModel.provider || session.model.id !== roleModel.id) {
      await session.setModel(roleModel);
    }
    session.setThinkingLevel(options.thinkingLevel);
    session.setActiveToolsByName(options.tools);
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

export async function disposeChildSession(session: AgentSession): Promise<void> {
  try {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

class EffectiveAuthCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, Credential>();

  constructor(authByProvider: ReadonlyMap<string, AuthResult | undefined>) {
    for (const [providerId, result] of authByProvider) {
      if (result?.auth.apiKey || result?.env) {
        this.credentials.set(providerId, {
          type: "api_key",
          key: result.auth.apiKey,
          env: result.env,
        });
      }
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.credentials.get(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  async modify(
    providerId: string,
    update: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const next = await update(this.credentials.get(providerId));
    if (next) this.credentials.set(providerId, next);
    return next;
  }

  async delete(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

function withEffectiveNativeAuth(
  provider: Provider,
  effectiveAuth: AuthResult | undefined,
  availableModelIds?: ReadonlySet<string>,
): Provider {
  if (!effectiveAuth) return provider;
  const source = effectiveAuth.source ?? "outer session";
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
    filterModels: availableModelIds
      ? (models) => models.filter((model) => availableModelIds.has(model.id))
      : provider.filterModels
        ? (models, credential) => provider.filterModels!(models, credential)
        : undefined,
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
  };
}

/** Transfer effective auth and extension-registered providers before role-model preflight. */
export async function createChildModelRuntime(
  outerRegistry: ModelRegistry,
  signal?: AbortSignal,
  effectiveAuth?: ReadonlyMap<string, AuthResult | undefined>,
  availableModels?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create(
    effectiveAuth ? { credentials: new EffectiveAuthCredentialStore(effectiveAuth) } : undefined,
  );
  const selectedProviders = new Set<string>(effectiveAuth?.keys() ?? []);
  for (const providerId of outerRegistry.getRegisteredProviderIds()) {
    if (selectedProviders.has(providerId)) continue;
    const native = outerRegistry.getRegisteredNativeProvider(providerId);
    if (native) {
      runtime.registerNativeProvider(
        withEffectiveNativeAuth(
          native,
          effectiveAuth?.get(providerId),
          availableModels?.get(providerId),
        ),
      );
      continue;
    }
    const config = outerRegistry.getRegisteredProviderConfig(providerId);
    if (config) runtime.registerProvider(providerId, config);
  }
  for (const [providerId, result] of effectiveAuth ?? []) {
    const provider = outerRegistry.getProvider(providerId);
    if (!provider) continue;
    runtime.registerNativeProvider(
      withEffectiveNativeAuth(provider, result, availableModels?.get(providerId)),
    );
  }

  const refresh = await runtime.refresh({ allowNetwork: false, signal });
  if (signal?.aborted) {
    const error = new Error("Review loop aborted during model discovery.");
    error.name = "AbortError";
    throw error;
  }
  // A selected static model may remain usable when an unrelated dynamic catalog fails.
  // Model-specific resolution below decides whether these errors matter.
  void refresh;
  return runtime;
}

export async function ensureModelAuth(runtime: ModelRuntime, model: Model<Api>): Promise<void> {
  const auth = await runtime.getAuth(model);
  if (!auth) {
    throw new Error(
      `No usable authentication for ${model.provider}/${model.id}. Open /settings-review or run /login ${model.provider}.`,
    );
  }
}

function resolveReference(
  configured: ModelReference | undefined,
  currentModel: Model<Api> | undefined,
  role: "Reviewer" | "Fixer",
): ModelReference {
  if (configured) return configured;
  if (!currentModel) {
    throw new Error(
      `${role} model is set to current model, but the outer Pi session has no selected model.`,
    );
  }
  return { provider: currentModel.provider, modelId: currentModel.id };
}

async function resolveOneRole(
  role: "Reviewer" | "Fixer",
  configuredReference: ModelReference | undefined,
  configuredThinking: ModelThinkingLevel | undefined,
  currentModel: Model<Api> | undefined,
  currentThinking: ModelThinkingLevel,
  runtime: ModelRuntime,
): Promise<{ model: Model<Api>; resolved: ResolvedRoleModel }> {
  const reference = resolveReference(configuredReference, currentModel, role);
  const model = runtime.getModel(reference.provider, reference.modelId);
  if (!model) {
    throw new Error(
      `${role} model ${formatModelReference(reference)} is unavailable. Choose another model in /settings-review.`,
    );
  }
  await ensureModelAuth(runtime, model);
  const available = await runtime.getAvailable(reference.provider).catch((error) => {
    throw new Error(
      `${role} model ${formatModelReference(reference)} could not be preflighted: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  if (!available.some((candidate) => candidate.id === reference.modelId)) {
    throw new Error(
      `${role} model ${formatModelReference(reference)} is not available with the configured account. Choose another model in /settings-review.`,
    );
  }
  const requestedThinking = configuredThinking ?? currentThinking;
  const thinkingLevel = clampThinkingLevel(model, requestedThinking);
  return {
    model,
    resolved: {
      reference,
      thinkingLevel,
      displayName: model.name || formatModelReference(reference),
    },
  };
}

function outerDiscoveryAbortError(): Error {
  const error = new Error("Review loop aborted during outer model discovery.");
  error.name = "AbortError";
  return error;
}

function assertOuterDiscoveryActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw outerDiscoveryAbortError();
}

async function awaitOuterDiscovery<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  assertOuterDiscoveryActive(signal);
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(outerDiscoveryAbortError());
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolvePromise, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export interface ResolvedModels {
  runtime: ModelRuntime;
  reviewerModel: Model<Api>;
  fixerModel: Model<Api>;
  reviewer: ResolvedRoleModel;
  fixer: ResolvedRoleModel;
}

export async function resolveRoleModels(options: {
  settings: ReviewLoopSettings;
  currentModel: Model<Api> | undefined;
  currentThinking: ModelThinkingLevel | undefined;
  outerRegistry: ModelRegistry;
  signal?: AbortSignal;
}): Promise<ResolvedModels> {
  const currentThinking = options.currentThinking ?? "medium";
  const reviewerReference = resolveReference(
    options.settings.reviewerModel,
    options.currentModel,
    "Reviewer",
  );
  const fixerReference = resolveReference(
    options.settings.fixerModel,
    options.currentModel,
    "Fixer",
  );
  // The outer session maintains this registry snapshot. Refreshing every provider here has no
  // cancellation API and can strand the progress UI on an unrelated dynamic provider.
  assertOuterDiscoveryActive(options.signal);
  const outerAvailable = options.outerRegistry.getAvailable();
  const selected = [
    ["Reviewer", reviewerReference],
    ["Fixer", fixerReference],
  ] as const;
  for (const [role, reference] of selected) {
    const model = options.outerRegistry.find(reference.provider, reference.modelId);
    if (!model) {
      throw new Error(
        `${role} model ${formatModelReference(reference)} is unavailable. Choose another model in /settings-review.`,
      );
    }
    if (
      !outerAvailable.some(
        (candidate) =>
          candidate.provider === reference.provider && candidate.id === reference.modelId,
      )
    ) {
      throw new Error(
        `${role} model ${formatModelReference(reference)} is not available with the selected outer-session account. Choose another model in /settings-review.`,
      );
    }
  }
  const availableModels = new Map<string, Set<string>>();
  for (const model of outerAvailable) {
    const ids = availableModels.get(model.provider) ?? new Set<string>();
    ids.add(model.id);
    availableModels.set(model.provider, ids);
  }
  const effectiveAuth = new Map<string, AuthResult | undefined>();
  for (const providerId of new Set([reviewerReference.provider, fixerReference.provider])) {
    effectiveAuth.set(
      providerId,
      await awaitOuterDiscovery(options.outerRegistry.getProviderAuth(providerId), options.signal),
    );
  }
  assertOuterDiscoveryActive(options.signal);
  const runtime = await createChildModelRuntime(
    options.outerRegistry,
    options.signal,
    effectiveAuth,
    availableModels,
  );
  const reviewer = await resolveOneRole(
    "Reviewer",
    options.settings.reviewerModel,
    options.settings.reviewerThinking,
    options.currentModel,
    currentThinking,
    runtime,
  );
  const fixer = await resolveOneRole(
    "Fixer",
    options.settings.fixerModel,
    options.settings.fixerThinking,
    options.currentModel,
    currentThinking,
    runtime,
  );
  return {
    runtime,
    reviewerModel: reviewer.model,
    fixerModel: fixer.model,
    reviewer: reviewer.resolved,
    fixer: fixer.resolved,
  };
}

export function supportedThinkingLevels(model: Model<Api> | undefined): ModelThinkingLevel[] {
  return model ? getSupportedThinkingLevels(model) : ["off", "minimal", "low", "medium", "high"];
}

function addRawUsage(total: UsageSummary, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const usage = value as Record<string, unknown>;
  total.input += typeof usage.input === "number" ? usage.input : 0;
  total.output += typeof usage.output === "number" ? usage.output : 0;
  total.cacheRead += typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  total.cacheWrite += typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  if (typeof usage.cost === "object" && usage.cost !== null && "total" in usage.cost) {
    const cost = (usage.cost as Record<string, unknown>).total;
    total.cost += typeof cost === "number" ? cost : 0;
  }
}

export function usageFromMessages(messages: readonly unknown[]): UsageSummary {
  const total = emptyUsage();
  for (const value of messages) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("role" in value) ||
      value.role !== "assistant"
    )
      continue;
    total.turns += 1;
    if ("usage" in value) addRawUsage(total, value.usage);
  }
  return total;
}

export async function promptChild(
  session: AgentSession,
  prompt: string,
  signal?: AbortSignal,
  onUsage?: (usage: UsageSummary) => void,
): Promise<{ messages: unknown[]; usage: UsageSummary }> {
  if (signal?.aborted) {
    const error = new Error("Review loop aborted.");
    error.name = "AbortError";
    throw error;
  }
  const messages: unknown[] = [];
  const usage = emptyUsage();
  const recordUsage = (raw?: unknown): void => {
    const addition = emptyUsage();
    addition.turns = 1;
    if (raw !== undefined) addRawUsage(addition, raw);
    addUsage(usage, addition);
    onUsage?.(addition);
  };
  let lastAssistant: unknown;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end") {
      messages.push(event.message);
      if (event.message.role === "assistant") {
        lastAssistant = event.message;
        recordUsage(event.message.usage);
      }
    } else if (event.type === "compaction_end" && event.result?.usage) {
      // Compaction rewrites session.messages, but its provider usage remains observable here.
      recordUsage(event.result.usage);
    } else if (event.type === "summarization_retry_attempt_start") {
      // Failed summarization attempts do not expose token usage, but they are still model turns.
      recordUsage();
    }
  });
  let abortPromise: Promise<void> | undefined;
  let abortFailure: unknown;
  let hasAbortFailure = false;
  let rejectAbortFailure!: (error: Error) => void;
  const abortFailurePromise = new Promise<never>((_resolve, reject) => {
    rejectAbortFailure = reject;
  });
  void abortFailurePromise.catch(() => undefined);
  const recordAbortFailure = (error: unknown) => {
    hasAbortFailure = true;
    abortFailure = error;
    rejectAbortFailure(
      new Error(
        `Could not abort child session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ),
    );
  };
  const abort = () => {
    if (abortPromise) return;
    try {
      abortPromise = Promise.resolve(session.abort()).catch((error) => {
        recordAbortFailure(error);
      });
    } catch (error) {
      recordAbortFailure(error);
      abortPromise = Promise.resolve();
    }
  };
  const awaitAbort = async () => {
    await abortPromise;
    if (hasAbortFailure) {
      throw new Error(
        `Could not abort child session: ${abortFailure instanceof Error ? abortFailure.message : String(abortFailure)}`,
        { cause: abortFailure },
      );
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  // AbortSignal does not replay events that occur between the initial check and listener setup.
  if (signal?.aborted) abort();
  try {
    if (signal?.aborted) {
      await awaitAbort();
      const error = new Error("Review loop aborted.");
      error.name = "AbortError";
      throw error;
    }
    await Promise.race([
      session.prompt(prompt, { expandPromptTemplates: false, source: "extension" }),
      abortFailurePromise,
    ]);
  } finally {
    unsubscribe();
    signal?.removeEventListener("abort", abort);
    await awaitAbort();
  }
  if (signal?.aborted) {
    const error = new Error("Review loop aborted.");
    error.name = "AbortError";
    throw error;
  }
  if (
    lastAssistant &&
    typeof lastAssistant === "object" &&
    "stopReason" in lastAssistant &&
    (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
  ) {
    const detail =
      "errorMessage" in lastAssistant && typeof lastAssistant.errorMessage === "string"
        ? lastAssistant.errorMessage
        : `Child model stopped with ${String(lastAssistant.stopReason)}.`;
    throw new Error(detail);
  }
  return { messages, usage };
}
