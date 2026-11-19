import type { Api, Model } from "@earendil-works/pi-ai";

/** A speed actually sent on the wire; Off sends nothing. */
export type AppliedSpeed = "fast" | "ultrafast";

export type SpeedAdapterId = "codex" | "openai" | "anthropic" | "gateway" | "proxy";

/** Anthropic needs this beta for Fast on models still in research preview. */
export const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";
const ANTHROPIC_BETA_MODELS = new Set(["claude-opus-5"]);

/**
 * How one provider family expresses Fast and Ultrafast in a request body.
 * Every method returns a new object; callers' payloads are never mutated.
 */
export interface SpeedAdapter {
  readonly id: SpeedAdapterId;
  readonly label: string;
  apply(
    payload: Record<string, unknown>,
    model: Model<Api>,
    speed: AppliedSpeed,
    ultrafastTier?: string,
  ): Record<string, unknown>;
  /** Top-level body fields `apply` may change; a retry restores the caller's values for these. */
  readonly fields: readonly string[];
  /**
   * Values that request standard speed explicitly when the caller sent none, so a
   * fallback cannot inherit an account- or project-level default tier.
   */
  readonly standard?: Readonly<Record<string, unknown>>;
  /** Request headers whose values `apply` extends, with the value it adds. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What a payload asks for, for diagnostics. */
  requested(payload: Record<string, unknown>): string;
  /** Value for Pi's own `serviceTier` request option, which drives its cost estimate. */
  piServiceTier(speed: AppliedSpeed, ultrafastTier?: string): string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenAI Responses (API, ChatGPT sign-in, Codex backend, opted-in proxies): `service_tier`. */
function serviceTierAdapter(
  id: SpeedAdapterId,
  label: string,
  standard?: Record<string, unknown>,
): SpeedAdapter {
  const tier = (speed: AppliedSpeed, ultrafastTier?: string) =>
    speed === "fast" ? "priority" : (ultrafastTier ?? "ultrafast");
  return {
    id,
    label,
    apply: (payload, _model, speed, ultrafastTier) => ({
      ...payload,
      service_tier: tier(speed, ultrafastTier),
    }),
    fields: ["service_tier"],
    ...(standard ? { standard } : {}),
    requested: (payload) =>
      typeof payload.service_tier === "string" ? payload.service_tier : "omitted",
    piServiceTier: tier,
  };
}

const anthropicAdapter: SpeedAdapter = {
  id: "anthropic",
  label: "Anthropic",
  apply(payload, model, _speed) {
    const next: Record<string, unknown> = { ...payload, speed: "fast" };
    if (ANTHROPIC_BETA_MODELS.has(model.id)) {
      const betas = Array.isArray(payload.betas)
        ? payload.betas.filter((beta): beta is string => typeof beta === "string")
        : [];
      next.betas = [...new Set([...betas, ANTHROPIC_FAST_BETA])];
    }
    return next;
  },
  fields: ["speed"],
  // The SDK sends payload `betas` as this header; a standard retry must not keep the Fast beta.
  headers: { "anthropic-beta": ANTHROPIC_FAST_BETA },
  requested: (payload) => (typeof payload.speed === "string" ? payload.speed : "omitted"),
  piServiceTier: () => undefined,
};

/** Vercel AI Gateway: `providerOptions.gateway.speed`, and OpenAI's tier for Ultrafast. */
const gatewayAdapter: SpeedAdapter = {
  id: "gateway",
  label: "Vercel AI Gateway",
  apply(payload, _model, speed, ultrafastTier) {
    const options = isRecord(payload.providerOptions) ? payload.providerOptions : {};
    const gateway = isRecord(options.gateway) ? options.gateway : {};
    const openai = isRecord(options.openai) ? options.openai : {};
    const only = Array.isArray(gateway.only) ? gateway.only : undefined;
    // Ultrafast needs OpenAI as the provider. Never override a caller's own tier or a
    // routing list that excludes OpenAI; ask for Fast instead.
    const ultrafast =
      speed === "ultrafast" &&
      openai.serviceTier === undefined &&
      (only === undefined || only.includes("openai"));
    if (!ultrafast) {
      return {
        ...payload,
        providerOptions: { ...options, gateway: { ...gateway, speed: "fast" } },
      };
    }
    return {
      ...payload,
      providerOptions: {
        ...options,
        // Pin routing to OpenAI unless the caller already restricted it (to a list with OpenAI).
        gateway: only === undefined ? { ...gateway, only: ["openai"] } : gateway,
        openai: { ...openai, serviceTier: ultrafastTier ?? "ultrafast" },
      },
    };
  },
  fields: ["providerOptions"],
  requested(payload) {
    const options = isRecord(payload.providerOptions) ? payload.providerOptions : {};
    const openai = isRecord(options.openai) ? options.openai : {};
    const gateway = isRecord(options.gateway) ? options.gateway : {};
    if (typeof openai.serviceTier === "string") return openai.serviceTier;
    return typeof gateway.speed === "string" ? gateway.speed : "omitted";
  },
  piServiceTier: () => undefined,
};

/**
 * Undo `apply` on a sent body: restore the caller's values for the adapter's fields,
 * deleting only fields the caller did not send.
 */
export function restoreFields(
  adapter: SpeedAdapter,
  body: Record<string, unknown>,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const restored = { ...body };
  for (const field of adapter.fields) {
    if (Object.hasOwn(original, field)) restored[field] = original[field];
    else if (adapter.standard && Object.hasOwn(adapter.standard, field))
      restored[field] = adapter.standard[field];
    else delete restored[field];
  }
  return restored;
}

/** The caller's values for the adapter's fields, before `apply`. */
export function originalFields(
  adapter: SpeedAdapter,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const original: Record<string, unknown> = {};
  for (const field of adapter.fields)
    if (Object.hasOwn(payload, field)) original[field] = payload[field];
  return original;
}

export const SPEED_ADAPTERS = {
  codex: serviceTierAdapter("codex", "Codex"),
  proxy: serviceTierAdapter("proxy", "Codex proxy"),
  // The API resolves an omitted tier to the project's default, which may be Fast.
  openai: serviceTierAdapter("openai", "OpenAI", { service_tier: "default" }),
  anthropic: anthropicAdapter,
  gateway: gatewayAdapter,
} as const satisfies Record<SpeedAdapterId, SpeedAdapter>;

export function normalizedEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** Built-in providers whose official endpoints accept a speed field. */
export const NATIVE_SPEED_PROVIDERS = new Set([
  "openai-codex",
  "openai",
  "anthropic",
  "vercel-ai-gateway",
]);

/** Match only official endpoints; a custom base URL may be a different service. */
export function nativeAdapterFor(
  model: Model<Api> | undefined,
  baseUrl = model?.baseUrl,
): SpeedAdapter | undefined {
  if (!model) return undefined;
  if (model.provider === "openai-codex" && model.api === "openai-codex-responses")
    return SPEED_ADAPTERS.codex;
  const url = normalizedEndpoint(baseUrl);
  if (!url) return undefined;
  if (
    model.provider === "openai" &&
    model.api === "openai-responses" &&
    url === "https://api.openai.com/v1"
  )
    return SPEED_ADAPTERS.openai;
  if (
    model.provider === "anthropic" &&
    model.api === "anthropic-messages" &&
    (url === "https://api.anthropic.com" || url === "https://api.anthropic.com/v1")
  )
    return SPEED_ADAPTERS.anthropic;
  if (
    model.provider === "vercel-ai-gateway" &&
    model.api === "anthropic-messages" &&
    (url === "https://ai-gateway.vercel.sh" || url === "https://ai-gateway.vercel.sh/v1")
  )
    return SPEED_ADAPTERS.gateway;
  return undefined;
}
