import { readFile } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Explicit consent to request Codex priority through this Responses endpoint. */
export interface FastProxyRoute {
  provider: string;
  baseUrl: string;
}

function endpoint(value: unknown): string | undefined {
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

export function isCodexModel(
  model: Model<Api> | undefined,
): model is Model<"openai-codex-responses"> & { provider: "openai-codex" } {
  return model?.provider === "openai-codex" && model.api === "openai-codex-responses";
}

/** Immutable session scope shared by capability, runtime and payload decisions. */
export class FastModeRoutes {
  private readonly proxies = new Map<string, Set<string>>();

  constructor(routes: readonly FastProxyRoute[] = []) {
    if (!Array.isArray(routes) || routes.length > 64)
      throw new Error("Fast-mode proxy routes must be an array of at most 64 entries.");
    for (const route of routes) {
      const url = endpoint(route?.baseUrl);
      if (!route || typeof route.provider !== "string" || !/^[\w.-]+$/.test(route.provider) || !url)
        throw new Error(
          "Invalid Fast-mode proxy route: require an exact provider and HTTP(S) baseUrl without credentials, query or fragment.",
        );
      const urls = this.proxies.get(route.provider) ?? new Set<string>();
      urls.add(url);
      this.proxies.set(route.provider, urls);
    }
  }

  hasProvider(provider: string): boolean {
    return provider === "openai-codex" || this.proxies.has(provider);
  }

  includes(model: Model<Api> | undefined, baseUrl = model?.baseUrl): model is Model<Api> {
    if (isCodexModel(model)) return true;
    if (!model || model.api !== "openai-responses") return false;
    const url = endpoint(baseUrl);
    return url !== undefined && this.proxies.get(model.provider)?.has(url) === true;
  }
}

export const NATIVE_FAST_ROUTES = new FastModeRoutes();

/** Loaded only at session start/reload; no credentials are read or endpoints contacted. */
export async function loadFastProxyRoutes(path: string): Promise<FastModeRoutes> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return NATIVE_FAST_ROUTES;
    throw new Error("Could not read Fast-mode proxy configuration.", { cause: error });
  }
  try {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !Array.isArray(value.routes)) throw new Error();
    return new FastModeRoutes(value.routes);
  } catch {
    // Do not echo invalid values: an accidentally pasted URL may contain credentials.
    throw new Error(
      "Invalid Fast-mode proxy configuration: expected version 1 and routes with exact provider/HTTP(S) baseUrl pairs (no credentials, query or fragment).",
    );
  }
}
