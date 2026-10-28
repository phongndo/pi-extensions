import type {
  Api,
  ApiStreamOptions,
  Model,
  Provider,
  SimpleStreamOptions,
  StreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { OpenAICodexResponsesOptions } from "@earendil-works/pi-ai/api/openai-codex-responses";

import { isRecord, resolveFastCapability, type FastCapabilityResolver } from "./capabilities.ts";
import type { FastRequestJournal, FastRequestObservation } from "./diagnostics.ts";
import { NATIVE_FAST_ROUTES, isChatGPTCredential, type FastModeRoutes } from "./routes.ts";

const FAST_PROVIDER_MARKER = Symbol("pi-fast-mode.provider");
type PayloadHook = NonNullable<StreamOptions["onPayload"]>;
/** Which policy installed each hook, so only an identical policy is skipped on re-entry. */
const FAST_PAYLOAD_HOOKS = new WeakMap<
  PayloadHook,
  { readEnabled: FastModeReader; hooks?: FastModeHooks }
>();

type CodexTierOptions = Pick<OpenAICodexResponsesOptions, "serviceTier">;

export type FastModeReader = () => Promise<boolean>;

/** Options this extension priced as priority, mapped to the caller's own tier. */
const PRICED = new WeakMap<object, CodexTierOptions["serviceTier"]>();

/** Pi prices from the options' tier, so it must track each request; reused options would
 * otherwise keep priority pricing after /fast off. */
function priceAs(target: CodexTierOptions, priority: boolean): void {
  if (priority) {
    if (!PRICED.has(target)) PRICED.set(target, target.serviceTier);
    target.serviceTier = "priority";
  } else if (PRICED.has(target)) {
    const callerTier = PRICED.get(target);
    PRICED.delete(target);
    if (callerTier === undefined) delete target.serviceTier;
    else target.serviceTier = callerTier;
  }
}

export interface FastModeHooks {
  routes?: FastModeRoutes;
  resolveCapability?: FastCapabilityResolver;
  journal?: FastRequestJournal;
  isActive?: () => boolean;
}

export function withFastPayload<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  readEnabled: FastModeReader,
  hooks?: FastModeHooks,
): TOptions {
  // Virtual models re-enter the patched runtime with options this same policy decorated.
  const installed = options?.onPayload && FAST_PAYLOAD_HOOKS.get(options.onPayload);
  if (installed && installed.readEnabled === readEnabled && installed.hooks === hooks)
    return options;
  const previous = options?.onPayload;
  const effective = { ...options } as TOptions & CodexTierOptions;
  // A copy of options this extension priced must still be restorable to the caller's tier.
  if (options && PRICED.has(options)) PRICED.set(effective, PRICED.get(options));
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
      !(hooks?.routes ?? NATIVE_FAST_ROUTES).includes(
        requestModel,
        requestModel.baseUrl,
        isChatGPTCredential(requestOptions.apiKey) === true,
      ) ||
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
    // Pi prices from the request tier; that is not admission confirmation.
    const priority = fastPayload.service_tier === "priority";
    priceAs(effective, priority);
    if (isRecord(this)) priceAs(this as CodexTierOptions, priority);
    observation = hooks?.journal?.begin(
      requestModel,
      fastPayload,
      requestOptions,
      applied,
      capability,
    );
    return fastPayload;
  };
  FAST_PAYLOAD_HOOKS.set(effective.onPayload, { readEnabled, hooks });
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
  Object.defineProperty(decorated, FAST_PROVIDER_MARKER, { value: true });
  return decorated;
}
