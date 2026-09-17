import type {
  Api,
  ApiStreamOptions,
  Context,
  Model,
  Provider,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import type { OpenAICodexResponsesOptions } from "@earendil-works/pi-ai/api/openai-codex-responses";

import { isRecord, resolveFastCapability, type FastCapabilityResolver } from "./capabilities.ts";
import type { FastRequestJournal, FastRequestObservation } from "./diagnostics.ts";
import { NATIVE_FAST_ROUTES, type FastModeRoutes } from "./routes.ts";

const FAST_PROVIDER_MARKER = Symbol("pi-fast-mode.provider");

type CodexTierOptions = Pick<OpenAICodexResponsesOptions, "serviceTier">;

export type FastModeReader = () => Promise<boolean>;

export interface FastModeHooks {
  routes?: FastModeRoutes;
  resolveCapability?: FastCapabilityResolver;
  journal?: FastRequestJournal;
  isActive?: () => boolean;
}

export function supportsCodexFastMode(model: Model<Api> | undefined): model is Model<Api> {
  return model !== undefined && resolveFastCapability(model).status === "supported";
}

function isEligibleCodexFastPayload(
  payload: unknown,
  model: Model<Api> | undefined,
): payload is Record<string, unknown> {
  return supportsCodexFastMode(model) && isRecord(payload) && payload.model === model.id;
}

export function applyCodexFastMode(
  payload: unknown,
  model: Model<Api> | undefined,
  enabled: boolean,
): unknown {
  if (!enabled || !isEligibleCodexFastPayload(payload, model)) return payload;
  return { ...payload, service_tier: "priority" };
}

export function withFastPayload<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  readEnabled: FastModeReader,
  hooks?: FastModeHooks,
): TOptions {
  const previous = options?.onPayload;
  const effective = { ...options } as TOptions & CodexTierOptions;
  let observation: FastRequestObservation | undefined;
  if (hooks?.journal) {
    const fetchRequest = options?.fetch ?? globalThis.fetch;
    effective.fetch = async (input, init) => {
      const response = await fetchRequest(input, init);
      return hooks.isActive?.() === false
        ? response
        : (observation?.response(response) ?? response);
    };
  }
  effective.onPayload = async function (this: unknown, payload, requestModel) {
    const previousResult = await previous?.call(this, payload, requestModel);
    const transformed = previousResult === undefined ? payload : previousResult;
    // The receiver is the final API options, including runtime-resolved auth.
    // Pi applies endpoint overrides to requestModel; streamSimple may copy this hook.
    const requestOptions = isRecord(this) ? (this as StreamOptions) : effective;
    if (
      hooks?.isActive?.() === false ||
      !(hooks?.routes ?? NATIVE_FAST_ROUTES).includes(requestModel) ||
      !isRecord(transformed) ||
      transformed.model !== requestModel.id
    )
      return transformed;

    const capability =
      hooks?.resolveCapability?.(requestModel, requestOptions) ??
      resolveFastCapability(requestModel, hooks?.routes, requestOptions);
    const applied = capability.status === "supported" && (await readEnabled());
    if (hooks?.isActive?.() === false) return transformed;
    const fastPayload = applied ? { ...transformed, service_tier: "priority" } : transformed;
    if (fastPayload.service_tier === "priority") {
      effective.serviceTier = "priority";
      // Keep Pi's existing request-tier pricing behavior; it is not admission confirmation.
      if (isRecord(this)) this.serviceTier = "priority";
    }
    observation = hooks?.journal?.begin(
      requestModel,
      fastPayload,
      requestOptions,
      applied,
      capability,
    );
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

  const decorated: Provider = {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    auth: provider.auth,
    getModels: () => provider.getModels(),
    ...(provider.refreshModels
      ? { refreshModels: (context) => provider.refreshModels!(context) }
      : {}),
    ...(provider.filterModels
      ? { filterModels: (models, credential) => provider.filterModels!(models, credential) }
      : {}),
    stream<TApi extends Api>(
      model: Model<TApi>,
      context: Context,
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
  Object.defineProperty(decorated, FAST_PROVIDER_MARKER, { value: true });
  return decorated;
}
