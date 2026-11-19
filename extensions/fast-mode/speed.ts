import type { Api, Model } from "@earendil-works/pi-ai";
import type { AppliedSpeed, SpeedAdapter } from "./adapters.ts";
import type { FastCapability } from "./capabilities.ts";
import type { FastSpeed } from "./state.ts";

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 30 * 60_000;
const MAX_ERROR_BODY_CHARS = 16 * 1024;
const MAX_BLOCKS = 64;

/** Normalize legacy boolean readers. */
export function toSpeed(value: boolean | FastSpeed): FastSpeed {
  if (value === true) return "fast";
  if (value === false) return "off";
  return value;
}

export interface FastBlock {
  speed: AppliedSpeed;
  reason: string;
  /** Absent: blocked until the preference changes or `/fast refresh`. */
  until?: number;
}

/**
 * Session-local memory of speeds a provider refused, so later requests do not
 * pay for the same rejection. Keys are provider/model; no request data is kept.
 */
export class FastFallbacks {
  private readonly blocks = new Map<string, FastBlock[]>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private key(model: Model<Api>): string {
    return `${model.provider}/${model.id}`;
  }

  blocked(model: Model<Api>, speed: AppliedSpeed): FastBlock | undefined {
    const list = this.blocks.get(this.key(model));
    const now = this.now();
    return list?.find((block) => block.speed === speed && (block.until ?? Infinity) > now);
  }

  block(model: Model<Api>, speed: AppliedSpeed, reason: string, cooldownMs?: number): FastBlock {
    const block: FastBlock = {
      speed,
      reason,
      ...(cooldownMs === undefined ? {} : { until: this.now() + cooldownMs }),
    };
    const key = this.key(model);
    const list = (this.blocks.get(key) ?? []).filter((entry) => entry.speed !== block.speed);
    this.blocks.set(key, [...list, block]);
    if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    return block;
  }

  clear(): void {
    this.blocks.clear();
  }
}

/** The speed to send: Ultrafast where available, else Fast, else nothing. */
export function effectiveSpeed(
  preference: FastSpeed,
  capability: FastCapability,
  model?: Model<Api>,
  fallbacks?: FastFallbacks,
): AppliedSpeed | undefined {
  if (preference === "off") return undefined;
  if (
    preference === "ultrafast" &&
    capability.ultrafast === "supported" &&
    !(model && fallbacks?.blocked(model, "ultrafast"))
  )
    return "ultrafast";
  if (capability.status === "supported" && !(model && fallbacks?.blocked(model, "fast")))
    return "fast";
  return undefined;
}

/** The next lower speed to retry with after a refusal. */
export function downgrade(
  speed: AppliedSpeed,
  capability: FastCapability,
  model: Model<Api>,
  fallbacks: FastFallbacks,
): AppliedSpeed | undefined {
  if (
    speed === "ultrafast" &&
    capability.status === "supported" &&
    !fallbacks.blocked(model, "fast")
  )
    return "fast";
  return undefined;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(Math.max(seconds * 1000, 1000), MAX_COOLDOWN_MS);
  const date = header === null ? Number.NaN : Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 1000), MAX_COOLDOWN_MS);
  return DEFAULT_COOLDOWN_MS;
}

/** Read at most a bounded prefix of an error body, leaving the original response intact. */
async function errorText(response: Response): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return "";
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  } finally {
    await reader?.cancel().catch(() => undefined);
  }
}

/** The rejected parameter, when the error names one (OpenAI `error.param`). */
function errorParam(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    const error = isRecord(value) && isRecord(value.error) ? value.error : undefined;
    return typeof error?.param === "string" ? error.param : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SPEED_PARAMS = new Set(["service_tier", "speed", "serviceTier", "providerOptions"]);
/**
 * Messages that name the speed setting itself. A bare "speed" or "priority" is not
 * enough: it may be a tool or field name in an unrelated validation error.
 */
const SPEED_ERROR =
  /service[_ ]tier|\bultrafast\b|fast[ _-]mode|priority (processing|tier)|[`'"]speed[`'"]\s+(parameter|field|setting|option|is not)|\b(parameter|field|setting|option)\s+[`'"]?speed\b/i;

/** Anthropic reports Fast-specific limits in `anthropic-fast-*` headers. */
function fastLimitExhausted(response: Response): boolean {
  for (const [name, value] of response.headers)
    if (name.startsWith("anthropic-fast-") && name.endsWith("-remaining") && Number(value) <= 0)
      return true;
  return false;
}

const FAST_MENTION = /fast[ _-]?mode|\bfast\b[^.]{0,40}\b(limit|capacity)/i;

/**
 * Decide whether a failed response refused the requested speed. Anthropic's Fast
 * rate limit and capacity errors (429/529) cool down, but only when the response
 * points at Fast: an org-wide limit or general overload stays with Pi's normal
 * retry path. An explicit refusal of the tier blocks it for the session.
 * Anything else is the caller's error to handle.
 */
export async function classifyRefusal(
  response: Response,
  adapter: SpeedAdapter,
): Promise<{ reason: string; cooldownMs?: number } | undefined> {
  if (response.ok) return undefined;
  if (adapter.id === "anthropic" && (response.status === 429 || response.status === 529)) {
    const fast =
      (response.status === 429 && fastLimitExhausted(response)) ||
      FAST_MENTION.test(await errorText(response));
    if (!fast) return undefined;
    return {
      reason: `Fast rate limit or capacity (HTTP ${response.status})`,
      cooldownMs: retryAfterMs(response),
    };
  }
  if (![400, 403, 404, 422].includes(response.status)) return undefined;
  const text = await errorText(response);
  const param = errorParam(text);
  if (param !== undefined ? !SPEED_PARAMS.has(param) : !SPEED_ERROR.test(text)) return undefined;
  return { reason: `the provider refused the speed (HTTP ${response.status})` };
}
