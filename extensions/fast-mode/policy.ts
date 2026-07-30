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

const FAST_PROVIDER = "openai-codex";
const FAST_API = "openai-codex-responses";
const FAST_PROVIDER_MARKER = Symbol("pi-fast-mode.provider");

type CodexTierOptions = Pick<OpenAICodexResponsesOptions, "serviceTier">;

export type FastModeReader = () => Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsCodexFastMode(model: Model<Api> | undefined): model is Model<Api> {
  if (!model || model.provider !== FAST_PROVIDER || model.api !== FAST_API) return false;
  return model.id === "gpt-5.4" || model.id === "gpt-5.5" || /^gpt-5\.6(?:-|$)/.test(model.id);
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
): TOptions {
  const previous = options?.onPayload;
  const effective = { ...options } as TOptions & CodexTierOptions;
  effective.onPayload = async function (this: unknown, payload, requestModel) {
    const previousResult = await previous?.(payload, requestModel);
    const transformed = previousResult === undefined ? payload : previousResult;
    if (!isEligibleCodexFastPayload(transformed, requestModel)) return transformed;

    const fastPayload = applyCodexFastMode(transformed, requestModel, await readEnabled());
    if (isRecord(fastPayload) && fastPayload.service_tier === "priority") {
      effective.serviceTier = "priority";
      // streamSimple copies this hook; its receiver is the API options used for response pricing.
      if (isRecord(this)) this.serviceTier = "priority";
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

/** Decorate the Codex provider so child ModelRuntimes inherit Fast mode without loading extensions. */
export function decorateCodexProvider(provider: Provider, readEnabled: FastModeReader): Provider {
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
        withFastPayload(options, readEnabled) as ApiStreamOptions<TApi>,
      );
    },
    streamSimple(model, context, options?: SimpleStreamOptions) {
      return provider.streamSimple(model, context, withFastPayload(options, readEnabled));
    },
  };
  Object.defineProperty(decorated, FAST_PROVIDER_MARKER, { value: true });
  return decorated;
}
