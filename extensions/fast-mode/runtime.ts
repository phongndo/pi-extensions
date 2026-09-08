import type { Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  decorateCodexProvider,
  isFastModeProvider,
  withFastPayload,
  type FastModeHooks,
  type FastModeReader,
} from "./policy.ts";

interface Registration {
  readEnabled: FastModeReader;
  hooks?: FastModeHooks;
}

interface RuntimeFastModeInstallation {
  registrations: Set<Registration>;
  originalStream: ModelRuntime["stream"];
  originalStreamSimple: ModelRuntime["streamSimple"];
  stream: ModelRuntime["stream"];
  streamSimple: ModelRuntime["streamSimple"];
}

const runtimeFastModeInstallations = new WeakMap<ModelRuntime, RuntimeFastModeInstallation>();

function installFastModeRuntime(runtime: ModelRuntime, registration: Registration): () => void {
  let installation = runtimeFastModeInstallations.get(runtime);
  if (!installation) {
    const registrations = new Set([registration]);
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
      const current = registrations.values().next().value;
      return invokeOriginalStream(
        model,
        context,
        needsDecoration(model.provider) && current
          ? withFastPayload(options, current.readEnabled, current.hooks)
          : options,
      );
    };
    const streamSimple: ModelRuntime["streamSimple"] = (model, context, options) => {
      const current = registrations.values().next().value;
      return invokeOriginalStreamSimple(
        model,
        context,
        needsDecoration(model.provider) && current
          ? withFastPayload(options, current.readEnabled, current.hooks)
          : options,
      );
    };
    installation = { registrations, originalStream, originalStreamSimple, stream, streamSimple };
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
    installation.registrations.add(registration);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    installation!.registrations.delete(registration);
    if (installation!.registrations.size > 0) return;
    if (runtime.stream === installation!.stream) runtime.stream = installation!.originalStream;
    if (runtime.streamSimple === installation!.streamSimple)
      runtime.streamSimple = installation!.originalStreamSimple;
    runtimeFastModeInstallations.delete(runtime);
  };
}

interface RegistryFastModeInstallation {
  registrations: Set<Registration>;
  restore: () => void;
}

const registryFastModeInstallations = new WeakMap<ModelRegistry, RegistryFastModeInstallation>();

/** Compatibility seam until Pi exposes a public policy hook for host AND child runtimes. */
export function installFastModeProviderLookup(
  registry: ModelRegistry,
  readEnabled: FastModeReader,
  hooks?: FastModeHooks,
): () => void {
  const runtime = (registry as unknown as { runtime?: ModelRuntime }).runtime;
  if (
    !runtime ||
    typeof runtime.stream !== "function" ||
    typeof runtime.streamSimple !== "function" ||
    typeof runtime.getProvider !== "function" ||
    typeof runtime.getRegisteredNativeProvider !== "function" ||
    typeof registry.getProvider !== "function" ||
    typeof registry.getRegisteredNativeProvider !== "function"
  ) {
    throw new Error(
      "Fast mode requires the Pi 0.85.1-compatible model runtime interface (including child streams). No decorators were installed.",
    );
  }
  let active = true;
  const registration: Registration = {
    readEnabled,
    hooks: { ...hooks, isActive: () => active && hooks?.isActive?.() !== false },
  };
  const removeRuntimeDecorator = installFastModeRuntime(runtime, registration);
  let installation = registryFastModeInstallations.get(registry);
  if (!installation) {
    const registrations = new Set([registration]);
    const originalGetProvider = registry.getProvider;
    const originalGetNativeProvider = registry.getRegisteredNativeProvider;
    const caches = new WeakMap<Registration, WeakMap<Provider, Provider>>();
    const decorate = (provider: Provider | undefined): Provider | undefined => {
      const current = registrations.values().next().value;
      if (!current || !provider || isFastModeProvider(provider)) return provider;
      let cache = caches.get(current);
      if (!cache) {
        cache = new WeakMap();
        caches.set(current, cache);
      }
      let decorated = cache.get(provider);
      if (!decorated) {
        decorated = decorateCodexProvider(provider, current.readEnabled, current.hooks);
        cache.set(provider, decorated);
      }
      return decorated;
    };
    const getProvider = (providerId: string) => {
      const provider = originalGetProvider.call(registry, providerId);
      return providerId === "openai-codex" ? decorate(provider) : provider;
    };
    const getNativeProvider = (providerId: string) => {
      const provider = originalGetNativeProvider.call(registry, providerId);
      return providerId === "openai-codex" ? decorate(provider) : provider;
    };
    const restore = () => {
      if (registry.getProvider === getProvider) registry.getProvider = originalGetProvider;
      if (registry.getRegisteredNativeProvider === getNativeProvider)
        registry.getRegisteredNativeProvider = originalGetNativeProvider;
    };
    try {
      registry.getProvider = getProvider;
      registry.getRegisteredNativeProvider = getNativeProvider;
      registry.getProvider("openai-codex");
      registry.getRegisteredNativeProvider("openai-codex");
    } catch (error) {
      active = false;
      registrations.clear();
      restore();
      removeRuntimeDecorator();
      throw new Error("Could not install the Fast provider decorator.", { cause: error });
    }
    installation = { registrations, restore };
    registryFastModeInstallations.set(registry, installation);
  } else installation.registrations.add(registration);

  return () => {
    if (!active) return;
    active = false;
    installation.registrations.delete(registration);
    if (installation.registrations.size === 0) {
      installation.restore();
      registryFastModeInstallations.delete(registry);
    }
    removeRuntimeDecorator();
  };
}
