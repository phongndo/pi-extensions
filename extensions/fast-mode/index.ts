import type { Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { installFastModeFooterPrefix } from "./footer.ts";
import { decorateCodexProvider, isFastModeProvider, withFastPayload } from "./policy.ts";
import { loadFastMode, toggleFastMode } from "./state.ts";

interface RuntimeFastModeInstallation {
  readers: Set<() => Promise<boolean>>;
  originalStream: ModelRuntime["stream"];
  originalStreamSimple: ModelRuntime["streamSimple"];
  stream: ModelRuntime["stream"];
  streamSimple: ModelRuntime["streamSimple"];
}

const runtimeFastModeInstallations = new WeakMap<ModelRuntime, RuntimeFastModeInstallation>();

function installFastModeRuntime(
  runtime: ModelRuntime,
  readEnabled: () => Promise<boolean>,
): () => void {
  let installation = runtimeFastModeInstallations.get(runtime);
  if (!installation) {
    const readers = new Set([readEnabled]);
    const originalStream = runtime.stream;
    const originalStreamSimple = runtime.streamSimple;
    const invokeOriginalStream = originalStream.bind(runtime) as ModelRuntime["stream"];
    const invokeOriginalStreamSimple = originalStreamSimple.bind(
      runtime,
    ) as ModelRuntime["streamSimple"];
    const needsDecoration = (providerId: string): boolean => {
      if (providerId !== "openai-codex") return false;
      const provider =
        runtime.getRegisteredNativeProvider(providerId) ?? runtime.getProvider(providerId);
      return provider !== undefined && !isFastModeProvider(provider);
    };
    const stream: ModelRuntime["stream"] = (model, context, options) => {
      const reader = readers.values().next().value;
      return invokeOriginalStream(
        model,
        context,
        needsDecoration(model.provider) && reader ? withFastPayload(options, reader) : options,
      );
    };
    const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) => {
      const reader = readers.values().next().value;
      return invokeOriginalStreamSimple(
        model,
        context,
        needsDecoration(model.provider) && reader ? withFastPayload(options, reader) : options,
      );
    };
    installation = {
      readers,
      originalStream,
      originalStreamSimple,
      stream,
      streamSimple,
    };
    runtimeFastModeInstallations.set(runtime, installation);
    try {
      runtime.stream = stream;
      runtime.streamSimple = streamSimple;
    } catch (error) {
      if (runtime.stream === stream) runtime.stream = originalStream;
      if (runtime.streamSimple === streamSimple) runtime.streamSimple = originalStreamSimple;
      runtimeFastModeInstallations.delete(runtime);
      throw new Error("Could not install the Fast runtime decorator.", { cause: error });
    }
  } else {
    installation.readers.add(readEnabled);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    installation!.readers.delete(readEnabled);
    if (installation!.readers.size > 0) return;
    if (runtime.stream === installation!.stream) runtime.stream = installation!.originalStream;
    if (runtime.streamSimple === installation!.streamSimple) {
      runtime.streamSimple = installation!.originalStreamSimple;
    }
    runtimeFastModeInstallations.delete(runtime);
  };
}

export function installFastModeProviderLookup(
  registry: ModelRegistry,
  readEnabled: () => Promise<boolean>,
): () => void {
  const originalGetProvider = registry.getProvider;
  const originalGetNativeProvider = registry.getRegisteredNativeProvider;
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (!runtime) throw new Error("Fast mode could not access the model runtime.");
  const removeRuntimeDecorator = installFastModeRuntime(runtime, readEnabled);
  const decoratedProviders = new WeakMap<Provider, Provider>();
  let active = true;
  const readWhileActive = (): Promise<boolean> => (active ? readEnabled() : Promise.resolve(false));

  function decorate(provider: Provider | undefined): Provider | undefined {
    if (!provider || isFastModeProvider(provider)) return provider;
    const existing = decoratedProviders.get(provider);
    if (existing) return existing;
    const decorated = decorateCodexProvider(provider, readWhileActive);
    decoratedProviders.set(provider, decorated);
    return decorated;
  }

  const getProvider = (providerId: string) => {
    const provider = originalGetProvider.call(registry, providerId);
    return providerId === "openai-codex" ? decorate(provider) : provider;
  };
  const getNativeProvider = (providerId: string) => {
    const provider = originalGetNativeProvider.call(registry, providerId);
    return providerId === "openai-codex" ? decorate(provider) : provider;
  };
  try {
    registry.getProvider = getProvider;
    registry.getRegisteredNativeProvider = getNativeProvider;
    registry.getProvider("openai-codex");
    registry.getRegisteredNativeProvider("openai-codex");
  } catch (error) {
    if (registry.getProvider === getProvider) registry.getProvider = originalGetProvider;
    if (registry.getRegisteredNativeProvider === getNativeProvider) {
      registry.getRegisteredNativeProvider = originalGetNativeProvider;
    }
    active = false;
    removeRuntimeDecorator();
    throw new Error("Could not install the Fast provider decorator.", { cause: error });
  }

  return () => {
    active = false;
    if (registry.getProvider === getProvider) registry.getProvider = originalGetProvider;
    if (registry.getRegisteredNativeProvider === getNativeProvider) {
      registry.getRegisteredNativeProvider = originalGetNativeProvider;
    }
    removeRuntimeDecorator();
  };
}

export default function fastModeExtension(pi: ExtensionAPI): void {
  let enabled = false;
  let removeFooterPrefix: (() => void) | undefined;
  let removeProviderLookup: (() => void) | undefined;

  async function readEnabledForRequest(): Promise<boolean> {
    enabled = await loadFastMode();
    return enabled;
  }

  function ensureCodexProvider(ctx: ExtensionContext): void {
    ctx.modelRegistry.getProvider("openai-codex");
    ctx.modelRegistry.getRegisteredNativeProvider("openai-codex");
  }

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast mode globally",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/fast does not take arguments.", "warning");
        return;
      }

      try {
        enabled = await toggleFastMode();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      ctx.ui.notify(`Codex Fast mode ${enabled ? "enabled" : "disabled"} globally.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    removeFooterPrefix?.();
    removeFooterPrefix =
      ctx.mode === "tui" ? installFastModeFooterPrefix(() => enabled) : undefined;
    removeProviderLookup?.();
    removeProviderLookup = installFastModeProviderLookup(ctx.modelRegistry, readEnabledForRequest);
    try {
      enabled = await loadFastMode();
    } catch (error) {
      enabled = false;
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });

  pi.on("model_select", (_event, ctx) => {
    ensureCodexProvider(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    ensureCodexProvider(ctx);
  });

  pi.on("session_shutdown", () => {
    removeFooterPrefix?.();
    removeFooterPrefix = undefined;
    removeProviderLookup?.();
    removeProviderLookup = undefined;
  });
}
