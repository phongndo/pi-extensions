import {
  createProvider,
  envApiKeyAuth,
  lazyApi,
  type AuthResult,
  type Provider,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export const FIRECRAWL_PROVIDER_ID = "firecrawl";
const FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
const REQUEST_TIMEOUT_MS = 60_000;
type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function clipText(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(0, maximum) + "…";
}
export function createFirecrawlProvider(): Provider {
  return createProvider({
    id: FIRECRAWL_PROVIDER_ID,
    name: "Firecrawl",
    baseUrl: FIRECRAWL_BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("Firecrawl API key", ["FIRECRAWL_API_KEY"]),
    },
    models: [],
    api: lazyApi(async () => {
      throw new Error("Firecrawl does not provide language models.");
    }),
  });
}

function requiredApiKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key)
    throw new Error(
      "A Firecrawl API key is required. Run /login firecrawl to store one in Pi, or set FIRECRAWL_API_KEY before starting Pi.",
    );
  return key;
}

export async function resolveFirecrawlApiKey(
  getProviderAuth?: (providerId: string) => Promise<AuthResult | undefined>,
): Promise<string> {
  if (getProviderAuth) {
    const result = await getProviderAuth(FIRECRAWL_PROVIDER_ID);
    if (result?.auth.apiKey) return requiredApiKey(result.auth.apiKey);
  }
  return requiredApiKey(process.env.FIRECRAWL_API_KEY);
}

type FirecrawlMethod = "POST" | "GET" | "DELETE";

export async function firecrawlRequestForContext(
  ctx: ExtensionContext,
  path: string,
  body: JsonRecord | undefined,
  signal?: AbortSignal,
  method: FirecrawlMethod = "POST",
): Promise<JsonRecord> {
  const key = await resolveFirecrawlApiKey(
    ctx.modelRegistry.getProviderAuth.bind(ctx.modelRegistry),
  );
  return firecrawlRequest(path, body, signal, key, method);
}

export function providerMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  for (const field of [payload.error, payload.message]) {
    if (typeof field === "string" && field.trim()) return field.trim();
    if (isRecord(field) && typeof field.message === "string")
      return field.message;
  }
  return undefined;
}

function firecrawlUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#"))
    throw new Error("Invalid Firecrawl API path.");
  const url = new URL(`${FIRECRAWL_BASE_URL}${path}`);
  const base = new URL(FIRECRAWL_BASE_URL);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(`${base.pathname}/`)
  )
    throw new Error("Invalid Firecrawl API path.");
  return url.toString();
}

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
class ResponseTooLargeError extends Error {
  constructor() {
    super(
      "Firecrawl response exceeds the 16 MiB safety limit. Request fewer pages or narrower results.",
    );
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError();
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function firecrawlRequest(
  path: string,
  body: JsonRecord | undefined,
  signal?: AbortSignal,
  apiKeyOverride?: string,
  method: FirecrawlMethod = "POST",
): Promise<JsonRecord> {
  const key = requiredApiKey(apiKeyOverride ?? process.env.FIRECRAWL_API_KEY);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "X-Origin": "pi-web",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const requestUrl = firecrawlUrl(path);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(requestUrl, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: requestSignal,
    });
    raw = await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw error;
    if (signal?.aborted)
      throw new Error("Web request was cancelled.", { cause: error });
    if (timeout.aborted)
      throw new Error("Firecrawl request timed out.", { cause: error });
    throw new Error("Could not reach Firecrawl.", { cause: error });
  }
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`Firecrawl returned invalid JSON (${response.status}).`, {
      cause: error,
    });
  }
  if (!response.ok || (isRecord(payload) && payload.success === false)) {
    const message =
      providerMessage(payload) ?? response.statusText ?? "request failed";
    throw new Error(
      `Firecrawl request failed (${response.status}): ${clipText(message.replaceAll(key, "[redacted]"), 500)}`,
    );
  }
  if (!isRecord(payload))
    throw new Error("Firecrawl returned an invalid response.");
  return payload;
}
