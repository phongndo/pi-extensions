import { createHash } from "node:crypto";
import type { Api, Model, ProviderHeaders, StreamOptions } from "@earendil-works/pi-ai";

export interface FastCapability {
  status: "supported" | "unsupported" | "unknown";
  source: "model" | "catalog" | "fallback" | "none";
  reason: string;
}

export interface CapabilityAuth {
  apiKey?: string;
  headers?: ProviderHeaders;
  baseUrl?: string;
}

// Documented fallback, not an entitlement check. Unknown future names are never enabled by regex.
const FALLBACK_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
]);
const SEPARATE_MODELS = new Set(["gpt-5.4-mini", "gpt-5.3-codex-spark"]);
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCodexModel(model: Model<Api> | undefined): model is Model<Api> {
  // Router restores the native provider identity before the actual request. Recognize its
  // public route in the UI too, without admitting arbitrary account slots or other APIs.
  return (
    (model?.provider === "openai-codex" || model?.provider === "accounts-openai-codex") &&
    model.api === "openai-codex-responses"
  );
}

/** Read only capability fields; never retain server-provided instructions or other catalog data. */
export function capabilityFromMetadata(
  metadata: unknown,
  source: "model" | "catalog",
): FastCapability | undefined {
  if (!isRecord(metadata)) return undefined;
  const tiers = metadata.service_tiers;
  const legacy = metadata.additional_speed_tiers;
  if (tiers === undefined && legacy === undefined) return undefined;
  if (
    (tiers !== undefined &&
      (!Array.isArray(tiers) ||
        !tiers.every((tier) => isRecord(tier) && typeof tier.id === "string"))) ||
    (legacy !== undefined &&
      (!Array.isArray(legacy) || !legacy.every((tier) => typeof tier === "string")))
  ) {
    return { status: "unknown", source, reason: "Malformed service-tier metadata." };
  }
  const supported =
    (tiers as Array<{ id: string }> | undefined)?.some((tier) =>
      ["priority", "fast"].includes(tier.id),
    ) || (legacy as string[] | undefined)?.includes("fast");
  return {
    status: supported ? "supported" : "unsupported",
    source,
    reason: supported
      ? "Fast is advertised in service-tier metadata."
      : "Metadata does not advertise Fast.",
  };
}

export function resolveFastCapability(model: Model<Api> | undefined): FastCapability {
  if (!isCodexModel(model)) {
    return {
      status: "unsupported",
      source: "none",
      reason: "Requires the openai-codex provider and Responses API.",
    };
  }
  const metadata = capabilityFromMetadata(model, "model");
  if (metadata) return metadata;
  if (FALLBACK_MODELS.has(model.id)) {
    return {
      status: "supported",
      source: "fallback",
      reason: "Documented model fallback; account availability is unverified.",
    };
  }
  if (SEPARATE_MODELS.has(model.id)) {
    return {
      status: "unsupported",
      source: "fallback",
      reason: "This separate model is not in the documented Fast-mode family.",
    };
  }
  return {
    status: "unknown",
    source: "none",
    reason: "No Fast capability metadata or documented fallback for this model.",
  };
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
    return "https://chatgpt.com/backend-api/codex/models?client_version=0.85.1";
  } catch {
    return undefined;
  }
}

function authHeaders(model: Model<Api>, auth: CapabilityAuth): Headers {
  const headers = new Headers();
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

  constructor(fetchCatalog: typeof fetch = globalThis.fetch, now: () => number = Date.now) {
    this.fetchCatalog = fetchCatalog;
    this.now = now;
  }

  resolve(model: Model<Api> | undefined, auth?: CapabilityAuth): FastCapability {
    if (!isCodexModel(model)) return resolveFastCapability(model);
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
