import { createHash } from "node:crypto";
import type { Api, Model, ProviderHeaders, StreamOptions } from "@earendil-works/pi-ai";
import { FastModeRoutes, NATIVE_FAST_ROUTES, isCodexModel } from "./routes.ts";

export { isCodexModel } from "./routes.ts";

export type FastSupport = "supported" | "unsupported" | "unknown";

export interface FastCapability {
  /** Fast support. */
  status: FastSupport;
  /** Ultrafast support; never "supported" without a verifiable source. */
  ultrafast: FastSupport;
  /** The catalog's Ultrafast tier id, sent verbatim (as Codex does). */
  ultrafastTier?: string;
  source: "model" | "catalog" | "fallback" | "none";
  reason: string;
}

export interface CapabilityAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
}

/** Looks up another model in the registry, e.g. an AI Gateway `-fast` variant. */
export type ModelLookup = (provider: string, id: string) => boolean;

// Documented fallbacks, not entitlement checks. Unknown future names are never enabled by regex.
// OpenAI Fast: https://learn.chatgpt.com/docs/agent-configuration/speed
const OPENAI_FAST_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
]);
// OpenAI Ultrafast (plan-gated: Pro $500, eligible Enterprise/Edu for 6 Astra and 6.1 Sol).
// Used only where no account catalog exists; the Codex backend uses its catalog instead.
const OPENAI_ULTRAFAST_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.2-astra",
  "gpt-6.2-sol",
]);
const OPENAI_SEPARATE_MODELS = new Set(["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex-spark"]);
// Anthropic Fast: https://platform.claude.com/docs/en/build-with-claude/fast-mode
// Opus 4.8 is omitted: its Fast mode is removed on 2026-11-30.
const ANTHROPIC_FAST_MODELS = new Set([
  "claude-fable-5-2",
  "claude-mythos-5-2",
  "claude-opus-5-5",
  "claude-opus-5",
]);
/** Like Claude Code, don't carry another model's Fast opt-in over to Fable.
 * https://code.claude.com/docs/en/fast-mode#switch-models-while-fast-mode-is-on
 */
export function requiresAdvisorFastOptIn(model: Model<Api>): boolean {
  return model.provider === "anthropic" && model.id === "claude-fable-5-2";
}

const CACHE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
// Codex hides models newer than the reported client; report a current CLI release.
const CODEX_CATALOG_CLIENT_VERSION = "0.170.0";
// The catalog is tailored per originator; ask as Pi, which is what Pi's requests send.
const CODEX_ORIGINATOR = "pi";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capability(
  status: FastSupport,
  ultrafast: FastSupport,
  source: FastCapability["source"],
  reason: string,
  ultrafastTier?: string,
): FastCapability {
  return {
    status,
    ultrafast,
    source,
    reason,
    ...(ultrafast === "supported" && ultrafastTier ? { ultrafastTier } : {}),
  };
}

/** Read only capability fields; never retain server-provided instructions or other catalog data. */
export function capabilityFromMetadata(
  metadata: unknown,
  source: "model" | "catalog",
): FastCapability | undefined {
  if (!isRecord(metadata)) return undefined;
  // Codex catalogs use snake_case; Pi provider extensions (and T3 Code) use `serviceTiers`.
  // Fall back to camelCase only when snake_case is absent; a null value is malformed, not missing.
  const tiers =
    metadata.service_tiers !== undefined ? metadata.service_tiers : metadata.serviceTiers;
  const legacy = metadata.additional_speed_tiers;
  if (tiers === undefined && legacy === undefined) return undefined;
  if (
    (tiers !== undefined &&
      (!Array.isArray(tiers) ||
        !tiers.every((tier) => isRecord(tier) && typeof tier.id === "string"))) ||
    (legacy !== undefined &&
      (!Array.isArray(legacy) || !legacy.every((tier) => typeof tier === "string")))
  ) {
    return capability("unknown", "unknown", source, "Malformed service-tier metadata.");
  }
  const ids = new Set([
    ...((tiers as Array<{ id: string }> | undefined) ?? []).map((tier) => tier.id),
    ...((legacy as string[] | undefined) ?? []),
  ]);
  const fast = ids.has("priority") || ids.has("fast");
  const ultrafast = ids.has("ultrafast");
  const advertised = [fast && "Fast", ultrafast && "Ultrafast"].filter(Boolean).join(" and ");
  return capability(
    fast ? "supported" : "unsupported",
    ultrafast ? "supported" : "unsupported",
    source,
    advertised
      ? `${advertised} advertised in service-tier metadata.`
      : "Metadata does not advertise Fast.",
    "ultrafast",
  );
}

function resolveOpenAICapability(model: Model<Api>, codexFamily: boolean): FastCapability {
  if (OPENAI_FAST_MODELS.has(model.id)) {
    // Without an account catalog, Codex-family Ultrafast stays unknown rather than guessed.
    const ultrafast: FastSupport = OPENAI_ULTRAFAST_MODELS.has(model.id)
      ? codexFamily
        ? "unknown"
        : "supported"
      : "unsupported";
    return capability(
      "supported",
      ultrafast,
      "fallback",
      ultrafast === "supported"
        ? "Documented Fast and Ultrafast model; Ultrafast is plan-gated and account availability is unverified."
        : "Documented model fallback; account availability is unverified.",
      "ultrafast",
    );
  }
  if (OPENAI_SEPARATE_MODELS.has(model.id))
    return capability(
      "unsupported",
      "unsupported",
      "fallback",
      "This separate model is not in the documented Fast-mode family.",
    );
  return capability(
    "unknown",
    "unknown",
    "none",
    "No Fast capability metadata or documented fallback for this model.",
  );
}

function resolveAnthropicCapability(model: Model<Api>): FastCapability {
  return ANTHROPIC_FAST_MODELS.has(model.id)
    ? capability(
        "supported",
        "unsupported",
        "fallback",
        "Documented Claude Fast model; organization enablement and usage credits are unverified.",
      )
    : capability(
        "unsupported",
        "unsupported",
        "fallback",
        "Claude Fast is not documented for this model.",
      );
}

function resolveGatewayCapability(model: Model<Api>, hasModel?: ModelLookup): FastCapability {
  if (model.id.endsWith("-fast"))
    return capability(
      "unsupported",
      "unsupported",
      "fallback",
      "This is already a Fast variant model; select its base model to toggle speed.",
    );
  const openaiId = model.id.startsWith("openai/") ? model.id.slice("openai/".length) : undefined;
  const ultrafast: FastSupport =
    openaiId !== undefined && OPENAI_ULTRAFAST_MODELS.has(openaiId) ? "supported" : "unsupported";
  const variant = hasModel?.(model.provider, `${model.id}-fast`);
  const fast: FastSupport =
    variant === true ? "supported" : variant === false ? "unsupported" : "unknown";
  return capability(
    fast,
    ultrafast,
    "fallback",
    fast === "supported"
      ? "AI Gateway lists a Fast variant of this model; the gateway speed option is unverified."
      : "AI Gateway lists no Fast variant of this model.",
    "ultrafast",
  );
}

export function resolveFastCapability(
  model: Model<Api> | undefined,
  routes: FastModeRoutes = NATIVE_FAST_ROUTES,
  auth?: CapabilityAuth,
  hasModel?: ModelLookup,
): FastCapability {
  const adapter = routes.adapter(model, auth?.baseUrl);
  if (!model || !adapter) {
    return capability(
      "unsupported",
      "unsupported",
      "none",
      "Requires an official OpenAI, Codex, Anthropic or AI Gateway endpoint, or an opted-in Responses proxy route.",
    );
  }
  const metadata = capabilityFromMetadata(model, "model");
  if (metadata) return metadata;
  switch (adapter.id) {
    case "anthropic":
      return resolveAnthropicCapability(model);
    case "gateway":
      return resolveGatewayCapability(model, hasModel);
    case "proxy": {
      const resolved = resolveOpenAICapability(model, true);
      return resolved.source === "fallback" && resolved.status === "supported"
        ? {
            ...resolved,
            reason:
              "Documented model fallback on an opted-in proxy route; upstream account availability is unverified.",
          }
        : resolved;
    }
    default:
      return resolveOpenAICapability(model, adapter.id === "codex");
  }
}

/** Never probe a custom proxy or follow redirects with provider credentials. */
export function codexModelsUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (
      url.origin !== "https://chatgpt.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["/backend-api", "/backend-api/codex", "/backend-api/codex/responses"].includes(
        url.pathname.replace(/\/+$/, ""),
      )
    )
      return undefined;
    return `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`;
  } catch {
    return undefined;
  }
}

function authHeaders(model: Model<Api>, auth: CapabilityAuth): Headers {
  const headers = new Headers({ originator: CODEX_ORIGINATOR });
  if (auth.apiKey) {
    headers.set("authorization", `Bearer ${auth.apiKey}`);
    try {
      const claims: unknown = JSON.parse(
        Buffer.from(auth.apiKey.split(".")[1] ?? "", "base64url").toString(),
      );
      const account = isRecord(claims) ? claims["https://api.openai.com/auth"] : undefined;
      if (isRecord(account) && typeof account.chatgpt_account_id === "string") {
        headers.set("chatgpt-account-id", account.chatgpt_account_id);
      }
    } catch {
      /* Non-JWT custom credentials have no account claim. */
    }
  }
  // Match caller precedence, but do not forward unrelated tracing or arbitrary headers.
  for (const values of [model.headers, auth.headers]) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const name = key.toLowerCase();
      if (name !== "authorization" && name !== "chatgpt-account-id") continue;
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }
  return headers;
}

function scopeFor(
  model: Model<Api>,
  auth: CapabilityAuth,
): { url: string; key: string; headers: Headers } | undefined {
  const url = codexModelsUrl(auth.baseUrl ?? model.baseUrl);
  if (!url) return undefined;
  const headers = authHeaders(model, auth);
  if (!headers.has("authorization")) return undefined;
  const key = createHash("sha256")
    .update(JSON.stringify([url, [...headers]]))
    .digest("hex");
  return { url, key, headers };
}

async function readCatalog(response: Response): Promise<Map<string, FastCapability>> {
  if (!response.body) throw new Error("Codex model catalog had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_CATALOG_BYTES)
        throw new Error("Codex model catalog exceeded the size limit.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid Codex model catalog JSON.");
  }
  if (!isRecord(value) || !Array.isArray(value.models))
    throw new Error("Invalid Codex model catalog shape.");
  const capabilities = new Map<string, FastCapability>();
  for (const entry of value.models) {
    if (!isRecord(entry) || typeof entry.slug !== "string" || entry.slug.length > 256) continue;
    const capability = capabilityFromMetadata(entry, "catalog");
    if (capability) capabilities.set(entry.slug, capability);
  }
  return capabilities;
}

/** Memory-only, credential-scoped catalog cache. Discovery never runs in the payload hot path. */
export class CodexCapabilities {
  private snapshot?: {
    key: string;
    url: string;
    expiresAt: number;
    models: Map<string, FastCapability>;
  };
  private lastAttempt?: { key: string; retryAt: number };
  private generation = 0;
  private pending?: { key: string; signal: AbortSignal; promise: Promise<void> };
  error?: string;

  private readonly fetchCatalog: typeof fetch;
  private readonly now: () => number;
  private readonly routes: FastModeRoutes;
  private readonly hasModel?: ModelLookup;

  constructor(
    fetchCatalog: typeof fetch = globalThis.fetch,
    now: () => number = Date.now,
    routes: FastModeRoutes = NATIVE_FAST_ROUTES,
    hasModel?: ModelLookup,
  ) {
    this.fetchCatalog = fetchCatalog;
    this.now = now;
    this.routes = routes;
    this.hasModel = hasModel;
  }

  resolve(model: Model<Api> | undefined, auth?: CapabilityAuth): FastCapability {
    if (!isCodexModel(model)) return resolveFastCapability(model, this.routes, auth, this.hasModel);
    const local = capabilityFromMetadata(model, "model");
    if (local) return local;
    const snapshot = this.snapshot;
    const scope = auth ? scopeFor(model, auth) : undefined;
    if (snapshot && snapshot.expiresAt > this.now() && scope?.key === snapshot.key) {
      return snapshot.models.get(model.id) ?? resolveFastCapability(model);
    }
    return resolveFastCapability(model);
  }

  async refresh(
    model: Model<Api>,
    auth: CapabilityAuth,
    signal: AbortSignal,
    force = false,
  ): Promise<void> {
    const scope = isCodexModel(model) ? scopeFor(model, auth) : undefined;
    if (!scope) {
      this.clear();
      this.error =
        "Discovery requires authenticated access to the official Codex endpoint; using local capabilities.";
      return;
    }
    if (!force && this.pending?.key === scope.key && !this.pending.signal.aborted)
      return this.pending.promise;
    if (
      !force &&
      !this.pending?.signal.aborted &&
      this.lastAttempt?.key === scope.key &&
      this.lastAttempt.retryAt > this.now()
    )
      return;
    const generation = ++this.generation;
    if (this.snapshot?.key !== scope.key) this.snapshot = undefined;
    this.lastAttempt = { key: scope.key, retryAt: this.now() + RETRY_MS };
    const promise = Promise.resolve().then(async () => {
      try {
        const response = await this.fetchCatalog(scope.url, {
          headers: scope.headers,
          signal,
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Codex capability discovery returned HTTP ${response.status}.`);
        }
        const models = await readCatalog(response);
        signal.throwIfAborted();
        if (generation !== this.generation) return;
        this.snapshot = {
          key: scope.key,
          url: scope.url,
          expiresAt: this.now() + CACHE_MS,
          models,
        };
        this.lastAttempt = { key: scope.key, retryAt: this.now() + CACHE_MS };
        this.error = undefined;
      } catch {
        if (generation !== this.generation) return;
        // Network errors can contain credentials/URLs from custom fetch implementations.
        this.error = signal.aborted
          ? "Capability discovery cancelled or timed out; using local capabilities."
          : "Capability discovery failed; using cached or local capabilities.";
      } finally {
        if (generation === this.generation) this.pending = undefined;
      }
    });
    this.pending = { key: scope.key, signal, promise };
    return promise;
  }

  clear(): void {
    this.generation++;
    this.snapshot = undefined;
    this.lastAttempt = undefined;
    this.pending = undefined;
    this.error = undefined;
  }
}

export type FastCapabilityResolver = (model: Model<Api>, options?: StreamOptions) => FastCapability;
