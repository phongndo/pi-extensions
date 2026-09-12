import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  cleanupSessionResources,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Credential,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  poolId,
  sourceProvider,
  isSubscriptionProvider,
  isSubscriptionAccount,
  type NativeAccount as Account,
} from "../../src/account-identity.ts";

import {
  classifyFailure,
  failureMessage,
  hasNoUsage,
  retryAt,
  type AccountHealth,
} from "./failures.ts";
export { limitReason, retryAt, type AccountHealth } from "./failures.ts";
import {
  DIAGNOSTIC_HINT,
  diagnosticSecrets,
  sanitizeDiagnostic,
  upstreamDiagnostic,
  type RouterDiagnostic,
} from "./diagnostics.ts";

export interface AttemptUsage {
  id: string;
  accountId: string;
  accountName: string;
  provider: string;
  model: string;
  subscription: true;
  timestamp: number;
  usage: AssistantMessage["usage"];
  outcome: string;
}
export interface RouterHooks {
  preferred?(provider: string): string | undefined;
  attempt?(usage: AttemptUsage): void;
  selected?(account: Account): void;
  failed?(diagnostic: RouterDiagnostic): void;
}

const zeroUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function failure(model: Model<Api>, aborted: boolean, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

/** One request-local routing loop; no global credential swapping or replay after visible output. */
export class AccountRouter {
  readonly health = new Map<string, AccountHealth>();
  readonly active = new Map<string, string>();
  private lifetime = new AbortController();
  private sessionIds = new Set<string>();
  private runtime: Pick<ModelRuntime, "registerNativeProvider" | "stream" | "streamSimple">;
  private readCredential: (id: string) => Promise<Credential | undefined>;
  private read: () => Promise<Account[]>;
  private lookup: (id: string) => Provider | undefined;
  private hooks: RouterHooks;
  private now: () => number;
  constructor(
    runtime: Pick<ModelRuntime, "registerNativeProvider" | "stream" | "streamSimple">,
    readCredential: (id: string) => Promise<Credential | undefined>,
    read: () => Promise<Account[]>,
    lookup: (id: string) => Provider | undefined,
    hooks: RouterHooks = {},
    now = Date.now,
  ) {
    this.runtime = runtime;
    this.readCredential = readCredential;
    this.read = read;
    this.lookup = lookup;
    this.hooks = hooks;
    this.now = now;
  }
  close(): void {
    this.lifetime.abort();
    for (const id of this.sessionIds) {
      try {
        cleanupSessionResources(id);
      } catch {
        /* Continue closing sibling account transports. */
      }
    }
    this.sessionIds.clear();
  }
  /**
   * The public route for a subscription provider: the source provider with its
   * own id and models, but a stream that picks the eligible account per request.
   * Pi keys auth and model endpoints by provider id, so keeping the id makes
   * routing transparent. Sessions record the normal provider, resumes resolve it
   * without the extension, and `/model` shows one row per provider.
   *
   * The fallback API-key check keeps the provider "configured" while Pi gates a
   * request, even when the original native login was removed and only pooled
   * slots remain. It carries no `login`, so it never offers an API-key sign-in.
   */
  provider(providerId: string): Provider | undefined {
    const base = this.lookup(providerId);
    if (!base || !isSubscriptionProvider(base)) return undefined;
    const available = async () =>
      (await this.read()).some(
        (a) => a.provider === providerId && isSubscriptionAccount(a, this.lookup(providerId)),
      );
    const apiKey = base.auth.apiKey;
    return {
      ...base,
      id: providerId,
      auth: {
        ...base.auth,
        apiKey: {
          ...(apiKey ?? { name: "Managed by /router" }),
          name: apiKey?.name ?? "Managed by /router",
          check: async (input) =>
            input.credential && apiKey?.check
              ? apiKey.check(input)
              : (await available())
                ? { type: "api_key" }
                : undefined,
          resolve: async (input) =>
            input.credential && apiKey?.resolve
              ? apiKey.resolve(input)
              : (await available())
                ? { auth: {} }
                : undefined,
        },
      },
      getModels: () => base.getModels(),
      stream: (model, context, options) => this.stream(model, context, options, false),
      streamSimple: (model, context, options) => this.stream(model, context, options, true),
    };
  }

  stream(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | StreamOptions = {},
    simple = true,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    const signal = AbortSignal.any([
      this.lifetime.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    void this.run(output, model, context, { ...options, signal }, simple).catch((cause) => {
      this.report(
        {
          timestamp: this.now(),
          provider: model.provider,
          model: model.id,
          stage: "routing",
          category: signal.aborted ? "aborted" : "routing",
          replaySafe: false,
        },
        cause,
        options,
      );
      // Detailed diagnostics live outside Pi's retry-controlling error string.
      const error = failure(
        model,
        signal.aborted,
        signal.aborted
          ? "Account request cancelled."
          : `Account routing failed. Check /router.${DIAGNOSTIC_HINT}`,
      );
      output.push({ type: "error", reason: error.stopReason as "error" | "aborted", error });
      output.end();
    });
    return output;
  }

  private async run(
    output: AssistantMessageEventStream,
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions,
    simple: boolean,
  ): Promise<void> {
    const signal = options.signal!;
    signal.throwIfAborted();
    if (options.deferred) throw new Error("Deferred account routing is unsupported");
    // Transparent routing: the public provider id is the source provider id. A legacy
    // `accounts-<provider>` tombstone normalizes here too, so a pre-migration request still routes.
    const providerId = sourceProvider(model.provider);
    const snapshot = await this.read();
    const base = this.lookup(providerId);
    if (!base || !isSubscriptionProvider(base))
      throw new Error("Subscription provider unavailable");
    const accounts = snapshot.filter(
      (a) =>
        a.provider === providerId &&
        isSubscriptionAccount(a, base) &&
        (this.health.get(a.id)?.until ?? 0) <= this.now(),
    );
    const preferred = this.hooks.preferred?.(providerId);
    accounts.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
    let attempted = false;
    for (const account of accounts) {
      signal.throwIfAborted();
      const credential = await this.readCredential(account.credentialId);
      signal.throwIfAborted();
      // Discovery is only a snapshot. Recheck the actual login method immediately before routing.
      if (credential?.type !== "oauth") continue;
      const source = base.getModels().find((m) => m.id === model.id && m.api === model.api);
      if (!source) continue;
      if (base.filterModels && !base.filterModels([source], credential).length) continue;
      const nativeModel = { ...model, provider: providerId, headers: source.headers };
      const nativeContext: Context = {
        ...context,
        // Old transcripts may name the retired `accounts-<provider>` route; normalize it back.
        messages: context.messages.map((m) =>
          m.role === "assistant" && m.provider === poolId(providerId)
            ? { ...m, provider: providerId }
            : m,
        ),
      };
      // The extension registered this account's slot (accountRouteProvider): OAuth-only
      // auth keyed by the credential id, delegating to the original provider. So a login
      // that changed to an API key after selection fails closed rather than borrowing auth.
      attempted = true;
      this.active.set(providerId, account.id);
      this.observe(() => this.hooks.selected?.(account));
      let status: number | undefined;
      let retryAfter: string | undefined;
      const { apiKey: _key, env: _env, ...rest } = options;
      const requestOptions: SimpleStreamOptions = {
        ...rest,
        maxRetries: 0,
        // Separate provider websocket/cache sessions across accounts as well as credentials.
        sessionId: `${options.sessionId ?? "pi"}:${account.id}`,
        onResponse: async (response, responseModel) => {
          status = response.status;
          retryAfter = response.headers["retry-after"];
          await options.onResponse?.(response, responseModel);
        },
      };
      this.sessionIds.add(requestOptions.sessionId!);
      const requestModel = { ...nativeModel, provider: account.credentialId };
      let visible = false;
      let replaySafe = true;
      let start: AssistantMessageEvent | undefined;
      let last: AssistantMessage | undefined;
      let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
      let thrown: unknown;
      try {
        const input = simple
          ? this.runtime.streamSimple(requestModel, nativeContext, requestOptions)
          : this.runtime.stream(requestModel, nativeContext, requestOptions);
        for await (const event of input) {
          const message =
            event.type === "error"
              ? event.error
              : event.type === "done"
                ? event.message
                : event.partial;
          // Evidence is sticky across the entire attempt, not just the final message.
          replaySafe &&= message.content.length === 0 && hasNoUsage(message.usage);
          if (event.type === "error" || event.type === "done") {
            // Pi's lazy adapter can turn an iterator exception into a fresh, empty error.
            // Do not let that discard the response and accounting already received.
            terminal =
              event.type === "error" && last
                ? {
                    ...event,
                    error: {
                      ...message,
                      content: message.content.length ? message.content : last.content,
                      usage: hasNoUsage(message.usage) ? last.usage : message.usage,
                    },
                  }
                : event;
            break;
          }
          last = message;
          if (event.type === "start") {
            if (!visible && !start) start = event;
            continue;
          }
          if (!visible && start) output.push(this.publicEvent(start, model.provider));
          visible = true;
          replaySafe = false;
          output.push(this.publicEvent(event, model.provider));
        }
        if (!terminal) throw new Error("Provider ended without a terminal event");
      } catch (cause) {
        thrown = cause;
        // Keep partial output/usage on iterator failures. Only provider execution is inside
        // this catch; metadata/storage failures must not become retryable transport errors.
        const error = {
          ...(last ?? failure(model, false, "")),
          stopReason: signal.aborted ? ("aborted" as const) : ("error" as const),
          errorMessage:
            cause instanceof Error
              ? cause.message
              : typeof cause === "string"
                ? cause
                : "Unknown provider failure",
        };
        terminal = { type: "error", reason: error.stopReason, error };
      }
      // Native OAuth may have refreshed the credential during this attempt. Redact both
      // selected and refreshed secrets. Diagnostic I/O is best effort; recheck abort afterwards.
      let latest: Credential | undefined;
      if (terminal.type === "error" && this.hooks.failed) {
        try {
          latest = await this.readCredential(account.credentialId);
        } catch {
          /* Best effort. */
        }
      }
      if (signal.aborted) {
        const error = {
          ...(terminal.type === "error" ? terminal.error : terminal.message),
          stopReason: "aborted" as const,
        };
        terminal = { type: "error", reason: "aborted", error };
      }
      const message = terminal.type === "error" ? terminal.error : terminal.message;
      // A provider may mutate its shared partial before throwing, without emitting a delta.
      replaySafe &&= message.content.length === 0 && hasNoUsage(message.usage);
      const problem = terminal.type === "error" ? classifyFailure(message, status) : undefined;
      if (problem && this.hooks.failed) {
        this.report(
          {
            timestamp: this.now(),
            provider: providerId,
            model: model.id,
            accountId: account.id,
            stage: "request",
            category: problem.kind,
            status,
            replaySafe,
          },
          thrown ?? message.errorMessage,
          credential,
          latest,
          options,
          model,
        );
      }
      this.observe(() =>
        this.hooks.attempt?.({
          id: randomUUID(),
          accountId: account.id,
          accountName: account.alias ?? account.name,
          provider: providerId,
          model: model.id,
          subscription: true,
          timestamp: this.now(),
          usage: structuredClone(message.usage),
          outcome: message.stopReason,
        }),
      );
      if (problem?.kind === "quota" || problem?.kind === "rate limit") {
        const reason = problem.kind;
        this.health.set(account.id, { until: retryAt(retryAfter, this.now(), reason), reason });
        if (replaySafe) continue;
      } else if (terminal.type === "done") this.health.delete(account.id);
      if (terminal.type === "error") {
        terminal = {
          ...terminal,
          error: {
            ...message,
            errorMessage: failureMessage(problem!, replaySafe) + DIAGNOSTIC_HINT,
          },
        };
      }
      if (!visible && start) output.push(this.publicEvent(start, model.provider));
      output.push(this.publicEvent(terminal, model.provider));
      output.end();
      return;
    }
    const error = failure(
      model,
      signal.aborted,
      attempted
        ? `All signed-in accounts have reached an allowance limit. Wait for a reset or use /login.${DIAGNOSTIC_HINT}`
        : "No signed-in account is eligible for this model. Check /login or wait for its allowance to reset.",
    );
    output.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error });
    output.end();
  }

  private report(
    diagnostic: Omit<RouterDiagnostic, "upstream">,
    cause: unknown,
    ...sources: unknown[]
  ): void {
    this.observe(() => {
      if (!this.hooks.failed) return;
      const secrets = diagnosticSecrets(...sources);
      this.hooks.failed({
        ...diagnostic,
        provider: sanitizeDiagnostic(diagnostic.provider, secrets),
        model: sanitizeDiagnostic(diagnostic.model, secrets),
        accountId: diagnostic.accountId && sanitizeDiagnostic(diagnostic.accountId, secrets),
        upstream: upstreamDiagnostic(cause, secrets),
      });
    });
  }

  /** Optional diagnostic/footer/usage observers must never turn a completed request into a failure. */
  private observe(callback: () => void): void {
    try {
      callback();
    } catch {
      /* Observer failures do not affect routing. */
    }
  }

  private publicEvent(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
    if (event.type === "done") return { ...event, message: { ...event.message, provider } };
    if (event.type === "error") return { ...event, error: { ...event.error, provider } };
    // Providers commonly reuse their terminal message as the start partial. Don't leak
    // its raw errorMessage through an otherwise redacted stream.
    const { errorMessage: _error, ...partial } = event.partial;
    return { ...event, partial: { ...partial, provider } };
  }
}
