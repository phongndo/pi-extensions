import type {
  Api,
  ApiStreamOptions,
  Model,
  Provider,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
  REQUEST_SPEED,
  type RequestSpeedOptions,
  type RequestSpeedReport,
} from "../../src/request-speed.ts";

import { originalFields, restoreFields, type AppliedSpeed, type SpeedAdapter } from "./adapters.ts";
import {
  isRecord,
  requiresAdvisorFastOptIn,
  resolveFastCapability,
  type FastCapability,
  type FastCapabilityResolver,
} from "./capabilities.ts";
import type { FastRequestJournal, FastRequestObservation } from "./diagnostics.ts";
import { NATIVE_FAST_ROUTES, type FastModeRoutes } from "./routes.ts";
import {
  classifyRefusal,
  downgrade,
  effectiveSpeed,
  toSpeed,
  type FastFallbacks,
} from "./speed.ts";
import type { FastSpeed } from "./state.ts";

const FAST_PROVIDER_MARKER = Symbol("pi-fast-mode.provider");

/** Reads the authoritative preference; booleans mean Fast/Off. */
export type FastModeReader = () => Promise<boolean | FastSpeed>;

export interface FastFallbackEvent {
  model: Model<Api>;
  from: AppliedSpeed;
  to: AppliedSpeed | undefined;
  reason: string;
}

export interface FastModeHooks {
  routes?: FastModeRoutes;
  resolveCapability?: FastCapabilityResolver;
  journal?: FastRequestJournal;
  /** Enables the one-shot lower-speed retry after a provider refuses a speed. */
  fallbacks?: FastFallbacks;
  onFallback?: (event: FastFallbackEvent) => void;
  isActive?: () => boolean;
}

export function supportsCodexFastMode(model: Model<Api> | undefined): model is Model<Api> {
  return model !== undefined && resolveFastCapability(model).status === "supported";
}

/** Pure payload transform for one model; used by tests and SDK embedders. */
export function applyCodexFastMode(
  payload: unknown,
  model: Model<Api> | undefined,
  enabled: boolean | FastSpeed,
  routes: FastModeRoutes = NATIVE_FAST_ROUTES,
): unknown {
  const adapter = routes.adapter(model);
  if (!model || !adapter || !isRecord(payload) || payload.model !== model.id) return payload;
  const capability = resolveFastCapability(model, routes);
  const speed = effectiveSpeed(toSpeed(enabled), capability);
  return speed ? adapter.apply(payload, model, speed, capability.ultrafastTier) : payload;
}

/** The request the payload hook decided on, read by the fetch wrapper that sends it. */
interface PendingRequest {
  model: Model<Api>;
  adapter: SpeedAdapter;
  capability: FastCapability;
  speed: AppliedSpeed;
  /** The caller's values for the adapter's fields, restored on a lower-speed retry. */
  original: Record<string, unknown>;
  /** Final request options whose `serviceTier` drives Pi's cost estimate. */
  options?: Record<string, unknown>;
  /** Header values this extension added, removed again for a standard-speed retry. */
  addedHeaders: Record<string, string>;
}

/** Remove one comma-separated value from a header, deleting the header if it empties. */
function withoutHeaderValue(headers: Headers, name: string, value: string): void {
  const current = headers.get(name);
  if (current === null) return;
  const kept = current
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part && part !== value);
  if (kept.length) headers.set(name, kept.join(","));
  else headers.delete(name);
}

interface SentBody {
  json: Record<string, unknown>;
  zstd: boolean;
}

/** Read the JSON body actually sent; undefined when it cannot be read safely. */
function decodeBody(init: RequestInit | undefined): SentBody | undefined {
  const zstd = new Headers(init?.headers).get("content-encoding")?.toLowerCase() === "zstd";
  let text: string;
  if (typeof init?.body === "string" && !zstd) text = init.body;
  else if (zstd && init?.body instanceof Uint8Array) {
    try {
      text = zstdDecompressSync(init.body).toString();
    } catch {
      return undefined;
    }
  } else return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return isRecord(json) ? { json, zstd } : undefined;
  } catch {
    return undefined;
  }
}

/** The speed a sent body carries, judged by the body itself, not by the latest decision. */
function sentSpeed(body: SentBody, pending: PendingRequest): AppliedSpeed | undefined {
  const requested = pending.adapter.requested(body.json);
  if (requested === "priority" || requested === "fast") return "fast";
  if (requested === (pending.capability.ultrafastTier ?? "ultrafast")) return "ultrafast";
  return undefined;
}

/** Rebuild the sent body at a lower speed (or the caller's own values). */
function lowerBody(
  json: Record<string, unknown>,
  pending: PendingRequest,
  lower: AppliedSpeed | undefined,
): Record<string, unknown> {
  const restored = restoreFields(pending.adapter, json, pending.original);
  return lower
    ? pending.adapter.apply(restored, pending.model, lower, pending.capability.ultrafastTier)
    : restored;
}

function encodeBody(json: Record<string, unknown>, zstd: boolean): BodyInit {
  const text = JSON.stringify(json);
  return zstd ? new Uint8Array(zstdCompressSync(text)) : text;
}

/** Pi's `serviceTier` request option for a body, so its cost estimate follows fallbacks. */
function pricingTier(
  adapter: SpeedAdapter,
  requested: string,
  capability: FastCapability,
): string | undefined {
  if (adapter.piServiceTier("fast") === undefined) return undefined;
  return requested === "priority" || requested === (capability.ultrafastTier ?? "ultrafast")
    ? requested
    : undefined;
}

export function withFastPayload<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  readEnabled: FastModeReader,
  hooks?: FastModeHooks,
): TOptions {
  const previous = options?.onPayload;
  const previousEvent = options?.onProviderStreamEvent;
  const control = (options as RequestSpeedOptions | undefined)?.[REQUEST_SPEED];
  let report: RequestSpeedReport | undefined;
  const effective = { ...options } as TOptions & { serviceTier?: string };
  let observation: FastRequestObservation | undefined;
  let pending: PendingRequest | undefined;
  if (hooks?.journal || hooks?.fallbacks) {
    const fetchRequest = options?.fetch ?? globalThis.fetch;
    effective.fetch = async (input, init) => {
      const request = pending;
      const fallbacks = hooks.fallbacks;
      if (hooks.isActive?.() === false || !request || !fallbacks) {
        const response = await fetchRequest(input, init);
        return hooks.isActive?.() === false
          ? response
          : (observation?.response(response) ?? response);
      }
      let sent = decodeBody(init);
      // Judge by the body actually sent: a provider retry may resend an earlier, faster one.
      let speed = sent ? sentSpeed(sent, request) : undefined;
      let headers = new Headers(init?.headers);
      let changed = false;
      const lowerTo = (lower: AppliedSpeed | undefined) => {
        const json = lowerBody(sent!.json, request, lower);
        const requested = request.adapter.requested(json);
        if (report) report.fellBackTo = lower ?? "standard";
        observation?.fellBack(lower, requested);
        const tier = pricingTier(request.adapter, requested, request.capability);
        effective.serviceTier = tier;
        if (request.options) request.options.serviceTier = tier;
        if (!lower)
          for (const [name, value] of Object.entries(request.addedHeaders))
            withoutHeaderValue(headers, name, value);
        headers.delete("content-length"); // The body changes size.
        sent = { json, zstd: sent!.zstd };
        speed = lower;
        changed = true;
      };
      // A paused speed stays paused for every later send of this request.
      while (sent && speed && fallbacks.blocked(request.model, speed))
        lowerTo(downgrade(speed, request.capability, request.model, fallbacks));
      const send = () =>
        fetchRequest(
          input,
          changed && sent ? { ...init, headers, body: encodeBody(sent.json, sent.zstd) } : init,
        );
      let response = await send();
      // Each pass lowers the speed, so this ends at standard after at most two retries.
      while (sent && speed && !response.ok) {
        const refusal = await classifyRefusal(response, request.adapter);
        if (!refusal) break;
        fallbacks.block(request.model, speed, refusal.reason, refusal.cooldownMs);
        const lower = downgrade(speed, request.capability, request.model, fallbacks);
        try {
          hooks.onFallback?.({ model: request.model, from: speed, to: lower, ...refusal });
        } catch {
          /* Notification is best-effort. */
        }
        await response.body?.cancel().catch(() => undefined);
        lowerTo(lower);
        response = await send();
      }
      return observation?.response(response) ?? response;
    };
  }
  if (hooks?.journal) {
    effective.onProviderStreamEvent = async function (this: unknown, data, model) {
      if (hooks.isActive?.() !== false) observation?.event(data);
      await previousEvent?.call(this, data, model);
    };
  }
  effective.onPayload = async function (this: unknown, payload, requestModel) {
    const previousResult = await previous?.call(this, payload, requestModel);
    const transformed = previousResult === undefined ? payload : previousResult;
    // The receiver is the final API options, including runtime-resolved auth.
    // Pi applies endpoint overrides to requestModel; streamSimple may copy this hook.
    const requestOptions = isRecord(this) ? (this as StreamOptions) : effective;
    const routes = hooks?.routes ?? NATIVE_FAST_ROUTES;
    const adapter = routes.adapter(requestModel);
    pending = undefined;
    if (
      hooks?.isActive?.() === false ||
      !adapter ||
      !isRecord(transformed) ||
      transformed.model !== requestModel.id
    )
      return transformed;

    const capability =
      hooks?.resolveCapability?.(requestModel, requestOptions) ??
      resolveFastCapability(requestModel, routes, requestOptions);
    const override = control?.preference;
    const available = capability.status === "supported" || capability.ultrafast === "supported";
    const canInherit =
      override !== "standard" &&
      !(override === "inherit" && requiresAdvisorFastOptIn(requestModel));
    let preference: FastSpeed = "off";
    if (override === "fast" || override === "ultrafast") preference = override;
    else if (canInherit && available) preference = toSpeed(await readEnabled());
    if (hooks?.isActive?.() === false) return transformed;
    const speed = effectiveSpeed(preference, capability, requestModel, hooks?.fallbacks);
    const fastPayload = speed
      ? adapter.apply(transformed, requestModel, speed, capability.ultrafastTier)
      : override && override !== "inherit" && available && adapter.standard
        ? { ...adapter.standard, ...transformed }
        : transformed;
    if (speed)
      pending = {
        model: requestModel,
        adapter,
        capability,
        speed,
        original: originalFields(adapter, transformed),
        addedHeaders: Object.fromEntries(
          Object.entries(adapter.headers ?? {}).filter(
            ([, value]) =>
              Array.isArray(fastPayload.betas) &&
              fastPayload.betas.includes(value) &&
              !(Array.isArray(transformed.betas) && transformed.betas.includes(value)),
          ),
        ),
        ...(isRecord(this) ? { options: this } : {}),
      };
    // Keep Pi's request-tier cost estimate, including a caller's own priority tier.
    // It is not admission confirmation.
    const requested = adapter.requested(fastPayload);
    const tier = pricingTier(adapter, requested, capability);
    if (tier !== undefined) {
      effective.serviceTier = tier;
      if (isRecord(this)) this.serviceTier = tier;
    }
    observation = hooks?.journal?.begin(requestModel, requested, requestOptions, speed, capability);
    if (control) {
      const snapshot: RequestSpeedReport = {
        preferred: preference === "off" ? "standard" : preference,
        requested:
          requested === "priority" || requested === "fast"
            ? "fast"
            : requested === (capability.ultrafastTier ?? "ultrafast")
              ? "ultrafast"
              : "standard",
      };
      report = snapshot;
      control.report = () => {
        const reportedTier = observation?.responseTier;
        return { ...snapshot, ...(reportedTier ? { reportedTier } : {}) };
      };
    }
    return fastPayload;
  };
  return effective;
}

export function isFastModeProvider(provider: Provider): boolean {
  return Boolean(
    (provider as Provider & { [FAST_PROVIDER_MARKER]?: boolean })[FAST_PROVIDER_MARKER],
  );
}

/** Decorate an eligible provider so child ModelRuntimes inherit policy without loading extensions. */
export function decorateCodexProvider(
  provider: Provider,
  readEnabled: FastModeReader,
  hooks?: FastModeHooks,
): Provider {
  if (isFastModeProvider(provider)) return provider;

  const overrides: Pick<Provider, "stream" | "streamSimple"> = {
    stream<TApi extends Api>(
      model: Model<TApi>,
      context: TranscriptContext,
      options?: ApiStreamOptions<TApi>,
    ) {
      return provider.stream(
        model,
        context,
        withFastPayload(options, readEnabled, hooks) as ApiStreamOptions<TApi>,
      );
    },
    streamSimple(model, context, options?: SimpleStreamOptions) {
      return provider.streamSimple(model, context, withFastPayload(options, readEnabled, hooks));
    },
  };
  const own = (key: PropertyKey) =>
    key === FAST_PROVIDER_MARKER || key === "stream" || key === "streamSimple";
  const read = (key: PropertyKey): unknown => {
    if (key === FAST_PROVIDER_MARKER) return true;
    if (key === "stream" || key === "streamSimple") return overrides[key];
    const value: unknown = Reflect.get(provider, key, provider);
    return typeof value === "function" ? value.bind(provider) : value;
  };
  // Delegate every other member live, including optional ones added by newer Pi versions
  // (classifiers, images, deferred fetches, model filters). The empty target keeps Proxy
  // invariants satisfied even for frozen providers.
  return new Proxy({} as Provider, {
    get: (_target, key) => read(key),
    has: (_target, key) => own(key) || Reflect.has(provider, key),
    ownKeys: () => [
      ...new Set<string | symbol>([
        ...Reflect.ownKeys(provider),
        "stream",
        "streamSimple",
        FAST_PROVIDER_MARKER,
      ]),
    ],
    getOwnPropertyDescriptor: (_target, key) =>
      own(key) || Reflect.getOwnPropertyDescriptor(provider, key)
        ? {
            configurable: true,
            // Enumerable, so a spread copy (`{ ...provider }`) is still recognized as decorated.
            enumerable: true,
            writable: !own(key),
            value: read(key),
          }
        : undefined,
    // Writes reach the real provider, as they did before decoration.
    set: (_target, key, value) => !own(key) && Reflect.set(provider, key, value, provider),
    defineProperty: (_target, key, descriptor) =>
      !own(key) && Reflect.defineProperty(provider, key, descriptor),
    deleteProperty: (_target, key) => !own(key) && Reflect.deleteProperty(provider, key),
  });
}
