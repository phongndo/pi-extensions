import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  cleanupSessionResources,
  isContextOverflow,
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
  accountLoginProvider,
  poolId,
  sourceProvider,
  isSubscriptionProvider,
  isSubscriptionAccount,
  type NativeAccount as Account,
} from "../../src/account-identity.ts";

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
export interface AccountHealth {
  until: number;
  reason: "rate limit" | "quota";
}
export interface RouterHooks {
  preferred?(provider: string): string | undefined;
  attempt?(usage: AttemptUsage): void;
  selected?(account: Account): void;
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

/** Missing or inconsistent totals are not proof of an unbilled, replayable attempt. */
function hasNoUsage(usage: AssistantMessage["usage"]): boolean {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ].every((value) => value === 0);
}

/** Deliberately narrow: auth, overload, context, and arbitrary network errors never rotate accounts. */
export function limitReason(
  status: number | undefined,
  message: string,
): AccountHealth["reason"] | undefined {
  if (status === 401 || status === 403) return undefined;
  if (
    /insufficient_quota|quota[_ ]exceeded|usage[_ ]limit[_ ]reached|GoUsageLimitError|FreeUsageLimitError|out of budget|credit balance is too low|exceeded your current quota/i.test(
      message,
    )
  )
    return "quota";
  if (
    status === 429 ||
    /\b429\b|rate[_ -]?limit|too many requests|ResourceExhausted/i.test(message)
  )
    return "rate limit";
  return undefined;
}
export function retryAt(
  value: string | undefined,
  now: number,
  reason: AccountHealth["reason"],
): number {
  const seconds = value?.trim() ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const target = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1000 : date;
  return Number.isFinite(target) && target > now
    ? target
    : now + (reason === "quota" ? 60 * 60_000 : 60_000);
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
  provider(providerId: string): Provider | undefined {
    const base = this.lookup(providerId);
    if (!base || !isSubscriptionProvider(base)) return undefined;
    const id = poolId(providerId);
    const available = async () =>
      (await this.read()).some(
        (a) => a.provider === providerId && isSubscriptionAccount(a, this.lookup(providerId)),
      );
    return {
      id,
      name: `${base.name} · Accounts`,
      auth: {
        apiKey: {
          name: "Managed by /router",
          check: async () => ((await available()) ? { type: "api_key" } : undefined),
          resolve: async () => ((await available()) ? { auth: {} } : undefined),
        },
      },
      getModels: () =>
        (this.lookup(providerId)?.getModels() ?? []).map((m) => ({
          ...m,
          provider: id,
          headers: undefined,
        })),
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
    void this.run(output, model, context, { ...options, signal }, simple).catch(() => {
      // Provider/storage exceptions may contain credentials. Never expose their raw messages.
      const error = failure(
        model,
        signal.aborted,
        signal.aborted
          ? "Account request cancelled."
          : "Account routing failed. Check /router and re-login if needed.",
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
      const alias = accountLoginProvider(base, account.credentialId, account.alias ?? account.name);
      const nativeModel = { ...model, provider: providerId, headers: source.headers };
      const nativeContext: Context = {
        ...context,
        messages: context.messages.map((m) =>
          m.role === "assistant" && m.provider === poolId(providerId)
            ? { ...m, provider: providerId }
            : m,
        ),
      };
      // Auth is resolved against the unique credential id, while transports retain their native provider identity.
      this.runtime.registerNativeProvider({
        ...alias,
        // Native auth reads the store again. If a login changes after selection, fail closed
        // instead of resolving an API key (or ambient auth) through a different method.
        auth: { oauth: base.auth.oauth },
        headers: base.headers,
        getModels: () => [{ ...nativeModel, provider: account.credentialId }],
        stream: (m, c, o) => base.stream({ ...m, provider: providerId }, c, o),
        streamSimple: (m, c, o) => base.streamSimple({ ...m, provider: providerId }, c, o),
      });
      attempted = true;
      this.active.set(providerId, account.id);
      this.hooks.selected?.(account);
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
      const input = simple
        ? this.runtime.streamSimple(requestModel, nativeContext, requestOptions)
        : this.runtime.stream(requestModel, nativeContext, requestOptions);
      let visible = false;
      let start: AssistantMessageEvent | undefined;
      let terminal = false;
      let rotate = false;
      for await (const event of input) {
        if (event.type === "start") {
          start = event;
          continue;
        }
        if (event.type === "error" || event.type === "done") {
          terminal = true;
          const message = event.type === "error" ? event.error : event.message;
          const reason =
            event.type === "error" && message.stopReason !== "aborted" && !signal.aborted
              ? limitReason(status, message.errorMessage ?? "")
              : undefined;
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
          });
          if (reason)
            this.health.set(account.id, { until: retryAt(retryAfter, this.now(), reason), reason });
          else if (event.type === "done") this.health.delete(account.id);
          const replaySafe = !visible && message.content.length === 0 && hasNoUsage(message.usage);
          if (reason && replaySafe) {
            rotate = true;
            break;
          }
          if (!visible && start) output.push(this.publicEvent(start, model.provider));
          output.push(this.publicEvent(event, model.provider, replaySafe));
          output.end();
          return;
        }
        if (!visible && start) output.push(this.publicEvent(start, model.provider));
        visible = true;
        output.push(this.publicEvent(event, model.provider));
      }
      if (!terminal) throw new Error("Provider ended without a terminal event");
      if (!rotate) break;
    }
    const error = failure(
      model,
      signal.aborted,
      attempted
        ? "All signed-in accounts have reached an allowance limit. Wait for a reset or use /login."
        : "No signed-in account is eligible for this model. Check /login or wait for its allowance to reset.",
    );
    output.push({ type: "error", reason: signal.aborted ? "aborted" : "error", error });
    output.end();
  }

  private publicEvent(
    event: AssistantMessageEvent,
    provider: string,
    replaySafe = false,
  ): AssistantMessageEvent {
    if (event.type === "done") return { ...event, message: { ...event.message, provider } };
    if (event.type === "error") {
      // Do not invite Pi's outer retry loop to replay a response the router deliberately stopped.
      const errorMessage =
        replaySafe && isContextOverflow(event.error)
          ? "context_length_exceeded: account request exceeds the model context window."
          : event.reason === "aborted"
            ? "Account request cancelled."
            : limitReason(undefined, event.error.errorMessage ?? "")
              ? "Account allowance exhausted. Request stopped; wait for its reset."
              : "Account request failed. Check provider availability or /login; no account fallback was attempted for this error.";
      return { ...event, error: { ...event.error, provider, errorMessage } };
    }
    return { ...event, partial: { ...event.partial, provider } };
  }
}
