import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFooterStatus } from "../../src/footer-status.ts";
import {
  CodexCapabilities,
  codexModelsUrl,
  isCodexModel,
  type CapabilityAuth,
} from "./capabilities.ts";
import { FastRequestJournal } from "./diagnostics.ts";
import { FAST_MODE_STATUS_KEY, formatFastDetails, formatFastFooterStatus } from "./footer.ts";
import { FastStateMonitor, snapshotSpeed, type FastStateChange } from "./monitor.ts";
import type { FastFallbackEvent } from "./policy.ts";
import { installFastModeProviderLookup } from "./runtime.ts";
import {
  FastModeRoutes,
  NATIVE_FAST_ROUTES,
  loadFastProxyRoutes,
  type FastProxyRoute,
} from "./routes.ts";
import { FastFallbacks } from "./speed.ts";
import { FAST_MODE_STATE_PATH } from "./state.ts";

export { installFastModeProviderLookup } from "./runtime.ts";

export interface FastModeExtensionOptions {
  statePath?: string;
  /** SDK opt-in; otherwise read fast-mode-proxies.json beside the preference file on startup/reload. */
  proxyRoutes?: readonly FastProxyRoute[];
  fetchCatalog?: typeof fetch;
  /** Disable discovery for offline embedding/testing; PI_OFFLINE also disables it. */
  discovery?: boolean;
  pollMs?: number;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    signal.throwIfAborted();
  }
  let cancel: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error("Capability discovery cancelled or timed out."));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Public factory seam for SDK embedding and offline lifecycle tests. */
export function createFastModeExtension(
  options: FastModeExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let current: FastModeSession | undefined;

    const runCommand = async (
      name: "fast" | "ultrafast",
      args: string,
      ctx: ExtensionContext,
    ): Promise<void> => {
      const action = args.trim().toLowerCase();
      const actions = name === "fast" ? ["", "on", "off", "status", "refresh"] : ["", "on", "off"];
      if (!actions.includes(action)) {
        ctx.ui.notify(
          name === "fast" ? "Usage: /fast [on|off|status|refresh]" : "Usage: /ultrafast [on|off]",
          "warning",
        );
        return;
      }
      if (!current) {
        ctx.ui.notify("Fast mode has no active session.", "error");
        return;
      }
      const session = current;
      session.setContext(ctx);
      try {
        if (action === "status" || action === "refresh") {
          await session.state.refresh();
          if (action === "refresh") {
            session.fallbacks.clear();
            await session.discover(true);
          }
        } else {
          if (session.policyError) throw new Error(session.policyError);
          const change: FastStateChange =
            action === "" ? { toggle: name } : action === "on" ? name : "off";
          await session.state.change(change);
          session.fallbacks.clear();
          void session.discover();
        }
        if (current === session)
          ctx.ui.notify(action === "status" ? session.status() : session.summary(), "info");
      } catch (error) {
        if (current === session)
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    };

    pi.registerCommand("fast", {
      description:
        "Fast mode globally (OpenAI, Codex, Claude, AI Gateway): on, off, status, refresh (bare /fast toggles)",
      getArgumentCompletions: (prefix) =>
        ["on", "off", "status", "refresh"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: (args, ctx) => runCommand("fast", args, ctx),
    });

    pi.registerCommand("ultrafast", {
      description:
        "Ultrafast globally where supported, else Fast: on, off (bare /ultrafast toggles; /fast status inspects)",
      getArgumentCompletions: (prefix) =>
        ["on", "off"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: (args, ctx) => runCommand("ultrafast", args, ctx),
    });

    pi.on("session_start", async (_event, ctx) => {
      current?.close();
      current = new FastModeSession(ctx, options);
      await current.start();
    });
    pi.on("model_select", async (_event, ctx) => {
      const session = current;
      if (!session) return;
      session.setContext(ctx);
      await session.state.refresh().catch(() => undefined);
      void session.discover();
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      const session = current;
      if (!session) return;
      session.setContext(ctx);
      await session.state.refresh().catch(() => undefined);
      void session.discover();
    });
    pi.on("session_shutdown", () => {
      current?.close();
      current = undefined;
    });
  };
}

class FastModeSession {
  readonly state: FastStateMonitor;
  readonly fallbacks = new FastFallbacks();
  policyError?: string;
  private ctx: ExtensionContext;
  private readonly options: FastModeExtensionOptions;
  private capabilities: CodexCapabilities;
  private routes = NATIVE_FAST_ROUTES;
  private readonly journal: FastRequestJournal;
  private readonly lifetime = new AbortController();
  private active = true;
  private removePolicy?: () => void;
  private uiAuth?: CapabilityAuth;
  private discovery?: { controller: AbortController; promise: Promise<void> };
  private discoveryGeneration = 0;
  private discoveryError?: string;
  private modelKey: string;
  private renderedStatus?: string;

  constructor(ctx: ExtensionContext, options: FastModeExtensionOptions) {
    this.ctx = ctx;
    this.modelKey = this.keyForContext(ctx);
    this.options = options;
    this.state = new FastStateMonitor(() => this.stateChanged(), options.statePath);
    this.capabilities = new CodexCapabilities(
      options.fetchCatalog,
      Date.now,
      NATIVE_FAST_ROUTES,
      this.hasModel,
    );
    this.journal = new FastRequestJournal(() => this.render());
  }

  /** AI Gateway Fast is offered only where the catalog lists a `-fast` variant. */
  private readonly hasModel = (provider: string, id: string): boolean => {
    try {
      return this.ctx.modelRegistry.find(provider, id) !== undefined;
    } catch {
      return false;
    }
  };

  private readonly onFallback = (event: FastFallbackEvent): void => {
    if (!this.active) return;
    const to =
      event.to === undefined ? "standard speed" : event.to === "fast" ? "Fast" : "Ultrafast";
    const from = event.from === "fast" ? "Fast" : "Ultrafast";
    try {
      this.ctx.ui.notify(
        `${from} unavailable for ${event.model.id}: ${event.reason}. Retried at ${to}.`,
        "warning",
      );
    } catch {
      /* UI teardown can race a request. */
    }
    this.render();
  };

  private snapshot() {
    return this.policyError ? { error: this.policyError } : this.state.snapshot;
  }

  private observedSpeed?: string;

  /**
   * Any session may change the shared preference. A change seen here, from this or another
   * session, ends paused speeds, as `/fast status` promises.
   */
  private stateChanged(): void {
    const speed = snapshotSpeed(this.state.snapshot);
    if (speed !== undefined && speed !== this.observedSpeed) {
      if (this.observedSpeed !== undefined) this.fallbacks.clear();
      this.observedSpeed = speed;
    }
    this.render();
  }

  private render(): void {
    if (!this.active || !this.ctx.hasUI) return;
    try {
      const status = formatFastFooterStatus(
        this.snapshot(),
        this.capabilities.resolve(this.ctx.model, this.uiAuth),
        this.ctx.model,
        this.fallbacks,
      );
      if (status === this.renderedStatus) return;
      setFooterStatus(this.ctx, FAST_MODE_STATUS_KEY, status);
      this.renderedStatus = status;
    } catch {
      /* UI teardown can race a background discovery/state refresh. */
    }
  }

  summary(): string {
    const state = this.snapshot();
    if (state.error) throw new Error(state.error);
    const speed = snapshotSpeed(state);
    if (speed === undefined) return "Fast mode unknown";
    if (speed === "ultrafast") return "Ultrafast mode on";
    return `Fast mode ${speed === "fast" ? "on" : "off"}`;
  }

  status(): string {
    return formatFastDetails(
      this.snapshot(),
      this.ctx.model,
      this.capabilities.resolve(this.ctx.model, this.uiAuth),
      this.journal.last,
      this.discoveryError ?? this.capabilities.error,
      this.fallbacks,
      this.routes.adapter(this.ctx.model)?.label,
    );
  }

  private keyForContext(ctx: ExtensionContext): string {
    return JSON.stringify([ctx.model?.provider, ctx.model?.api, ctx.model?.id, ctx.model?.baseUrl]);
  }

  setContext(ctx: ExtensionContext): void {
    const key = this.keyForContext(ctx);
    if (key !== this.modelKey) {
      this.modelKey = key;
      this.uiAuth = undefined;
      this.discoveryError = undefined;
      this.discovery?.controller.abort();
      this.discovery = undefined;
      this.discoveryGeneration++;
    }
    this.ctx = ctx;
    this.render();
  }

  async start(): Promise<void> {
    try {
      this.routes = this.options.proxyRoutes
        ? new FastModeRoutes(this.options.proxyRoutes)
        : await loadFastProxyRoutes(
            join(dirname(this.options.statePath ?? FAST_MODE_STATE_PATH), "fast-mode-proxies.json"),
          );
      if (!this.active) return;
      this.capabilities = new CodexCapabilities(
        this.options.fetchCatalog,
        Date.now,
        this.routes,
        this.hasModel,
      );
      this.removePolicy = installFastModeProviderLookup(
        this.ctx.modelRegistry,
        () => this.state.refresh(),
        {
          routes: this.routes,
          resolveCapability: (model, requestOptions) =>
            this.capabilities.resolve(model, requestOptions),
          journal: this.journal,
          fallbacks: this.fallbacks,
          onFallback: this.onFallback,
          isActive: () => this.active,
        },
      );
    } catch (error) {
      this.policyError = error instanceof Error ? error.message : String(error);
      this.ctx.ui.notify(this.policyError, "error");
    }
    await this.state.refresh().catch((error: unknown) => {
      if (this.active)
        this.ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    });
    if (!this.active) return;
    this.render();
    if (this.ctx.hasUI) this.state.start(this.options.pollMs, () => this.render());
    void this.discover();
  }

  async discover(force = false): Promise<void> {
    if (!this.active || this.policyError) return;
    if (this.discovery && !force) return this.discovery.promise;
    const model = this.ctx.model;
    if (!isCodexModel(model)) {
      // Only Codex has an account catalog; other providers use documented model lists.
      this.discoveryError =
        this.routes.adapter(model)?.id === "proxy"
          ? "Proxy capability discovery is disabled: upstream account availability and priority admission are unverified. Proxy credentials are never sent to ChatGPT."
          : undefined;
      return;
    }
    if (
      this.options.discovery === false ||
      (process.env.PI_OFFLINE && process.env.PI_OFFLINE !== "0")
    ) {
      this.discoveryError = "Capability discovery is disabled/offline; using local capabilities.";
      return;
    }
    if (!codexModelsUrl(model.baseUrl)) {
      this.uiAuth = undefined;
      this.discoveryError = "Custom endpoints are not probed; using local capabilities.";
      return;
    }
    this.discovery?.controller.abort();
    const controller = new AbortController();
    const generation = ++this.discoveryGeneration;
    const signal = AbortSignal.any([
      controller.signal,
      this.lifetime.signal,
      AbortSignal.timeout(5000),
    ]);
    const ctx = this.ctx;
    const promise = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted();
        const auth = await abortable(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
        signal.throwIfAborted();
        if (!auth.ok) throw new Error("Authentication unavailable.");
        if (generation !== this.discoveryGeneration || !this.active) return;
        this.uiAuth = auth;
        this.discoveryError = undefined;
        await abortable(this.capabilities.refresh(model, auth, signal, force), signal);
      } catch {
        if (generation !== this.discoveryGeneration || !this.active) return;
        this.uiAuth = undefined;
        this.discoveryError =
          "Capability discovery unavailable or timed out; using local capabilities.";
      } finally {
        if (generation === this.discoveryGeneration && this.active) {
          this.discovery = undefined;
          this.render();
        }
      }
    });
    this.discovery = { controller, promise };
    return promise;
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.lifetime.abort();
    this.discoveryGeneration++;
    this.state.close();
    this.removePolicy?.();
    this.removePolicy = undefined;
    this.capabilities.clear();
    this.fallbacks.clear();
    this.uiAuth = undefined;
    setFooterStatus(this.ctx, FAST_MODE_STATUS_KEY, undefined);
  }
}

export default createFastModeExtension();
