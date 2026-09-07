import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  CodexCapabilities,
  codexModelsUrl,
  isCodexModel,
  type CapabilityAuth,
} from "./capabilities.ts";
import { FastRequestJournal } from "./diagnostics.ts";
import {
  FAST_MODE_STATUS_KEY,
  formatFastDetails,
  formatFastStatus,
  installFastModeFooterPrefix,
} from "./footer.ts";
import { FastStateMonitor } from "./monitor.ts";
import { installFastModeProviderLookup } from "./runtime.ts";

export { installFastModeProviderLookup } from "./runtime.ts";

export interface FastModeExtensionOptions {
  statePath?: string;
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

    pi.registerCommand("fast", {
      description:
        "Codex Fast mode globally: on, off, status, refresh, details (bare /fast toggles)",
      getArgumentCompletions: (prefix) =>
        ["on", "off", "status", "refresh", "details"]
          .filter((value) => value.startsWith(prefix))
          .map((value) => ({ value, label: value })),
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase();
        if (!["", "on", "off", "status", "refresh", "details"].includes(action)) {
          ctx.ui.notify("Usage: /fast [on|off|status|refresh|details]", "warning");
          return;
        }
        if (!current) {
          ctx.ui.notify("Fast mode has no active session.", "error");
          return;
        }
        const session = current;
        session.setContext(ctx);
        try {
          if (action === "status" || action === "refresh" || action === "details") {
            await session.state.refresh();
            if (action === "refresh") await session.discover(true);
          } else {
            if (session.policyError) throw new Error(session.policyError);
            await session.state.change(action === "" ? undefined : action === "on");
            void session.discover();
          }
          if (current === session)
            ctx.ui.notify(action === "details" ? session.details() : session.status(), "info");
        } catch (error) {
          if (current === session)
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
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
  policyError?: string;
  private ctx: ExtensionContext;
  private readonly options: FastModeExtensionOptions;
  private readonly capabilities: CodexCapabilities;
  private readonly journal: FastRequestJournal;
  private readonly lifetime = new AbortController();
  private active = true;
  private removePolicy?: () => void;
  private removeFooterPrefix?: () => void;
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
    this.state = new FastStateMonitor(() => this.render(), options.statePath);
    this.capabilities = new CodexCapabilities(options.fetchCatalog);
    this.journal = new FastRequestJournal(() => this.render());
  }

  private snapshot() {
    return this.policyError
      ? { ...this.state.snapshot, error: this.policyError }
      : this.state.snapshot;
  }

  private render(): void {
    if (!this.active || !this.ctx.hasUI) return;
    try {
      const status = formatFastStatus(
        this.snapshot(),
        this.capabilities.resolve(this.ctx.model, this.uiAuth),
      );
      if (status === this.renderedStatus) return;
      // Clearing our TUI status also requests a render in Pi, so external toggles
      // redraw the inline glyph without creating a separate status row. RPC keeps text.
      this.ctx.ui.setStatus(FAST_MODE_STATUS_KEY, this.ctx.mode === "tui" ? undefined : status);
      this.renderedStatus = status;
    } catch {
      /* UI teardown can race a background discovery/state refresh. */
    }
  }

  status(): string {
    const state = this.snapshot();
    if (state.error) throw new Error(state.error);
    if (state.enabled === undefined) return "Fast mode unknown";
    return `Fast mode ${state.enabled ? "on" : "off"}`;
  }

  details(): string {
    return formatFastDetails(
      this.snapshot(),
      this.ctx.model,
      this.capabilities.resolve(this.ctx.model, this.uiAuth),
      this.journal.last,
      this.discoveryError ?? this.capabilities.error,
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
      this.discovery?.controller.abort();
      this.discovery = undefined;
      this.discoveryGeneration++;
    }
    this.ctx = ctx;
    this.render();
  }

  async start(): Promise<void> {
    try {
      if (this.ctx.mode === "tui") {
        this.removeFooterPrefix = installFastModeFooterPrefix(this.ctx.sessionManager, (model) => {
          const state = this.snapshot();
          return (
            this.active &&
            state.enabled === true &&
            !state.error &&
            this.capabilities.resolve(model, this.uiAuth).status === "supported"
          );
        });
      }
      this.removePolicy = installFastModeProviderLookup(
        this.ctx.modelRegistry,
        () => this.state.refresh(),
        {
          resolveCapability: (model, requestOptions) =>
            this.capabilities.resolve(model, requestOptions),
          journal: this.journal,
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
    if (!isCodexModel(model)) return;
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
    this.removeFooterPrefix?.();
    this.removePolicy?.();
    this.capabilities.clear();
    this.uiAuth = undefined;
    if (this.ctx.hasUI) this.ctx.ui.setStatus(FAST_MODE_STATUS_KEY, undefined);
  }
}

export default createFastModeExtension();
