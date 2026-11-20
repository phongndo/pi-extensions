import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ANTHROPIC_FAST_BETA,
  SPEED_ADAPTERS,
  nativeAdapterFor,
  originalFields,
  restoreFields,
} from "../adapters.ts";
import {
  CodexCapabilities,
  capabilityFromMetadata,
  resolveFastCapability,
} from "../capabilities.ts";
import { FastRequestJournal } from "../diagnostics.ts";
import { formatFastFooterStatus } from "../footer.ts";
import {
  applyCodexFastMode,
  isFastModeProvider,
  withFastPayload,
  type FastFallbackEvent,
} from "../policy.ts";
import { installFastModeProviderLookup } from "../runtime.ts";
import { NATIVE_FAST_ROUTES } from "../routes.ts";
import { FastFallbacks, effectiveSpeed } from "../speed.ts";
import {
  loadFastMode,
  loadFastSpeed,
  setFastMode,
  setFastSpeed,
  toggleFastMode,
  toggleFastSpeed,
} from "../state.ts";
import { catalog, model as codexModel, token, transcript } from "./helpers.ts";

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsStore: new InMemoryModelsStore(),
  allowModelNetwork: false,
});

function builtin(provider: string, id: string): Model<Api> {
  const found = runtime.getModel(provider, id);
  assert.ok(found, `${provider}/${id} is in Pi's catalog`);
  return found;
}

function sse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/event-stream" } });
}

function openaiDone(tier: string): string {
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "resp_test",
      status: "completed",
      service_tier: tier,
      output: [],
      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    },
  })}\n\n`;
}

function anthropicDone(speed: string): string {
  const usage = { input_tokens: 1, output_tokens: 1, speed };
  return [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        stop_reason: null,
        usage,
      },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function body(init: RequestInit | undefined): Record<string, unknown> {
  const zstd = new Headers(init?.headers).get("content-encoding") === "zstd";
  return JSON.parse(
    zstd ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body),
  );
}

test("state keeps version 1 so older readers see Ultrafast as Fast", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-speeds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fast-mode.json");
  assert.equal(await loadFastSpeed(path), "off");
  assert.equal(await setFastSpeed("ultrafast", path), "ultrafast");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    version: 1,
    enabled: true,
    ultrafast: true,
  });
  assert.equal(await loadFastMode(path), true, "legacy boolean readers see Fast");
  assert.equal(await toggleFastSpeed("ultrafast", path), "off");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, enabled: false });
  assert.equal(await toggleFastSpeed("ultrafast", path), "ultrafast");
  assert.equal(await toggleFastSpeed("fast", path), "fast", "switching speeds is not a toggle off");
  assert.equal(await toggleFastMode(path), false);

  await writeFile(path, JSON.stringify({ version: 1, enabled: false, ultrafast: true }));
  assert.equal(await loadFastSpeed(path), "off", "off wins over a stale ultrafast flag");
  await writeFile(path, JSON.stringify({ version: 1, enabled: true, ultrafast: "yes" }));
  await assert.rejects(loadFastSpeed(path), /ultrafast must be a boolean/);
});

test("native adapters match only official endpoints", () => {
  const openai = builtin("openai", "gpt-6.1-sol");
  const claude = builtin("anthropic", "claude-opus-5-5");
  const gateway = builtin("vercel-ai-gateway", "anthropic/claude-opus-5.5");
  assert.equal(nativeAdapterFor(openai)?.id, "openai");
  assert.equal(nativeAdapterFor(claude)?.id, "anthropic");
  assert.equal(nativeAdapterFor(gateway)?.id, "gateway");
  assert.equal(nativeAdapterFor(codexModel())?.id, "codex");
  assert.equal(nativeAdapterFor({ ...openai, baseUrl: "https://proxy.example/v1" }), undefined);
  assert.equal(nativeAdapterFor({ ...claude, baseUrl: "https://gateway.example" }), undefined);
  assert.equal(nativeAdapterFor({ ...openai, provider: "xai" }), undefined);
  assert.equal(NATIVE_FAST_ROUTES.hasProvider("anthropic"), true);
  assert.equal(NATIVE_FAST_ROUTES.hasProvider("xai"), false);
});

test("each adapter writes and strips its own wire format without touching other fields", () => {
  const openai = builtin("openai", "gpt-6.1-sol");
  const base = { model: openai.id, reasoning: { effort: "xhigh" } };
  const tiered = SPEED_ADAPTERS.openai.apply(base, openai, "ultrafast", "ultrafast");
  assert.deepEqual(tiered, { ...base, service_tier: "ultrafast" });
  assert.deepEqual(SPEED_ADAPTERS.openai.apply(base, openai, "fast"), {
    ...base,
    service_tier: "priority",
  });
  // A standard retry asks for "default" explicitly, so a project default of Fast cannot apply.
  assert.deepEqual(
    restoreFields(SPEED_ADAPTERS.openai, tiered, originalFields(SPEED_ADAPTERS.openai, base)),
    {
      ...base,
      service_tier: "default",
    },
  );
  const callerTier = { ...base, service_tier: "flex" };
  assert.deepEqual(
    restoreFields(SPEED_ADAPTERS.openai, tiered, originalFields(SPEED_ADAPTERS.openai, callerTier)),
    callerTier,
    "a caller's own tier is restored, not replaced",
  );
  const codex = SPEED_ADAPTERS.codex.apply(base, openai, "fast");
  assert.deepEqual(restoreFields(SPEED_ADAPTERS.codex, codex, {}), base);

  const opus5 = builtin("anthropic", "claude-opus-5");
  const opus55 = builtin("anthropic", "claude-opus-5-5");
  const claude = { model: opus5.id, betas: ["other-beta"] };
  assert.deepEqual(SPEED_ADAPTERS.anthropic.apply(claude, opus5, "fast"), {
    ...claude,
    speed: "fast",
    betas: ["other-beta", ANTHROPIC_FAST_BETA],
  });
  assert.deepEqual(SPEED_ADAPTERS.anthropic.apply({ model: opus55.id }, opus55, "fast"), {
    model: opus55.id,
    speed: "fast",
  });

  const gatewayModel = builtin("vercel-ai-gateway", "openai/gpt-6-astra");
  const routed = { model: gatewayModel.id, providerOptions: { gateway: { caching: "auto" } } };
  const fast = SPEED_ADAPTERS.gateway.apply(routed, gatewayModel, "fast");
  assert.deepEqual(fast.providerOptions, { gateway: { caching: "auto", speed: "fast" } });
  const ultra = SPEED_ADAPTERS.gateway.apply(routed, gatewayModel, "ultrafast");
  assert.deepEqual(ultra.providerOptions, {
    gateway: { caching: "auto", only: ["openai"] },
    openai: { serviceTier: "ultrafast" },
  });
  assert.equal(SPEED_ADAPTERS.gateway.requested(ultra), "ultrafast");
  assert.deepEqual(
    restoreFields(SPEED_ADAPTERS.gateway, ultra, originalFields(SPEED_ADAPTERS.gateway, routed)),
    routed,
  );
  // A caller's own allowlist is never widened or narrowed, and is restored on retry.
  const azureOnly = {
    model: gatewayModel.id,
    providerOptions: { gateway: { only: ["azure"] } },
  };
  assert.deepEqual(
    SPEED_ADAPTERS.gateway.apply(azureOnly, gatewayModel, "ultrafast").providerOptions,
    { gateway: { only: ["azure"], speed: "fast" } },
    "Ultrafast is skipped when the allowlist excludes OpenAI",
  );
  const openaiOnly = {
    model: gatewayModel.id,
    providerOptions: { gateway: { only: ["openai"] } },
  };
  const pinned = SPEED_ADAPTERS.gateway.apply(openaiOnly, gatewayModel, "ultrafast");
  assert.deepEqual(
    restoreFields(
      SPEED_ADAPTERS.gateway,
      pinned,
      originalFields(SPEED_ADAPTERS.gateway, openaiOnly),
    ),
    openaiOnly,
  );
  const ownTier = {
    model: gatewayModel.id,
    providerOptions: { openai: { serviceTier: "flex" } },
  };
  assert.deepEqual(
    SPEED_ADAPTERS.gateway.apply(ownTier, gatewayModel, "ultrafast").providerOptions,
    { openai: { serviceTier: "flex" }, gateway: { speed: "fast" } },
  );
});

test("capabilities: documented lists, catalog Ultrafast tiers, and gateway variants", async () => {
  const sol = resolveFastCapability(builtin("openai", "gpt-6.1-sol"));
  assert.equal(sol.status, "supported");
  assert.equal(sol.ultrafast, "supported");
  assert.equal(resolveFastCapability(builtin("openai", "gpt-6.1-terra")).ultrafast, "unsupported");
  assert.equal(resolveFastCapability(builtin("openai", "gpt-5.4-mini")).status, "unsupported");

  // Codex has an account catalog, so a documented list never guesses Ultrafast there.
  assert.equal(resolveFastCapability(codexModel("gpt-6.1-sol")).ultrafast, "unknown");
  const cache = new CodexCapabilities(async () =>
    catalog([
      {
        slug: "gpt-6.1-sol",
        service_tiers: [
          { id: "priority", name: "Fast" },
          { id: "ultrafast", name: "Ultrafast" },
        ],
      },
    ]),
  );
  const auth = { apiKey: token() };
  await cache.refresh(codexModel(), auth, AbortSignal.timeout(1000));
  const catalogSol = cache.resolve(codexModel("gpt-6.1-sol"), auth);
  assert.equal(catalogSol.ultrafast, "supported");
  assert.equal(catalogSol.ultrafastTier, "ultrafast");
  assert.equal(catalogSol.source, "catalog");

  // Pi provider extensions (and T3 Code) advertise camelCase `serviceTiers`.
  assert.equal(
    capabilityFromMetadata({ serviceTiers: [{ id: "ultrafast" }] }, "model")?.ultrafast,
    "supported",
  );

  assert.equal(resolveFastCapability(builtin("anthropic", "claude-opus-5-5")).status, "supported");
  assert.equal(resolveFastCapability(builtin("anthropic", "claude-fable-5-2")).status, "supported");
  for (const id of ["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-8"])
    assert.equal(resolveFastCapability(builtin("anthropic", id)).status, "unsupported", id);

  const lookup = (provider: string, id: string) => runtime.getModel(provider, id) !== undefined;
  const opus = builtin("vercel-ai-gateway", "anthropic/claude-opus-5.5");
  assert.equal(
    resolveFastCapability(opus, NATIVE_FAST_ROUTES, undefined, lookup).status,
    "supported",
  );
  assert.equal(resolveFastCapability(opus).status, "unknown", "no registry: unknown, not guessed");
  const variant = builtin("vercel-ai-gateway", "anthropic/claude-opus-5.5-fast");
  assert.equal(
    resolveFastCapability(variant, NATIVE_FAST_ROUTES, undefined, lookup).status,
    "unsupported",
  );
  const astra = builtin("vercel-ai-gateway", "openai/gpt-6-astra");
  assert.equal(
    resolveFastCapability(astra, NATIVE_FAST_ROUTES, undefined, lookup).ultrafast,
    "supported",
  );
});

test("Ultrafast falls back to Fast where only Fast exists, and footers say so", () => {
  const terra = builtin("openai", "gpt-6.1-terra");
  const capability = resolveFastCapability(terra);
  assert.equal(effectiveSpeed("ultrafast", capability), "fast");
  assert.equal(
    (applyCodexFastMode({ model: terra.id }, terra, "ultrafast") as Record<string, unknown>)
      .service_tier,
    "priority",
  );
  const sol = builtin("openai", "gpt-6.1-sol");
  assert.equal(
    (applyCodexFastMode({ model: sol.id }, sol, "ultrafast") as Record<string, unknown>)
      .service_tier,
    "ultrafast",
  );
  const state = { enabled: true, speed: "ultrafast" } as const;
  assert.equal(formatFastFooterStatus(state, capability, terra), "speed (fast, no ultra)");
  assert.equal(formatFastFooterStatus(state, resolveFastCapability(sol), sol), "speed (ultrafast)");
  const fallbacks = new FastFallbacks();
  fallbacks.block(sol, "ultrafast", "test");
  fallbacks.block(sol, "fast", "test");
  assert.equal(
    formatFastFooterStatus(state, resolveFastCapability(sol), sol, fallbacks),
    "speed (standard, fallback)",
  );
});

test("real OpenAI Responses requests carry Ultrafast and report the applied tier", async () => {
  const sol = builtin("openai", "gpt-6.1-sol");
  const sent: Array<Record<string, unknown>> = [];
  const journal = new FastRequestJournal();
  const options = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-test",
      fetch: async (_input, init) => {
        sent.push(body(init));
        return sse(openaiDone("ultrafast"));
      },
    },
    async () => "ultrafast",
    { journal, fallbacks: new FastFallbacks() },
  );
  const message = await openaiStream(
    sol as Model<"openai-responses">,
    transcript(),
    options,
  ).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(sent[0]?.service_tier, "ultrafast");
  assert.equal(journal.last?.appliedSpeed, "ultrafast");
  assert.equal(journal.last?.responseTier, "ultrafast");
});

test("a refused Ultrafast tier is retried once at Fast and paused for the session", async () => {
  const sol = builtin("openai", "gpt-6.1-sol");
  const sent: Array<Record<string, unknown>> = [];
  const fallbacks = new FastFallbacks();
  const events: FastFallbackEvent[] = [];
  const journal = new FastRequestJournal();
  const make = () =>
    withFastPayload<StreamOptions>(
      {
        apiKey: "sk-test",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const request = body(init);
          sent.push(request);
          if (request.service_tier === "ultrafast")
            return Response.json(
              {
                error: { message: "The requested service_tier is not available for this account." },
              },
              { status: 400 },
            );
          return sse(openaiDone("priority"));
        },
      },
      async () => "ultrafast",
      { journal, fallbacks, onFallback: (event) => events.push(event) },
    );
  const first = await openaiStream(sol as Model<"openai-responses">, transcript(), make()).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.deepEqual(
    sent.map((request) => request.service_tier),
    ["ultrafast", "priority"],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.to, "fast");
  assert.equal(journal.last?.fellBackTo, "fast");
  assert.ok(fallbacks.blocked(sol, "ultrafast"));

  const second = await openaiStream(
    sol as Model<"openai-responses">,
    transcript(),
    make(),
  ).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(sent.at(-1)?.service_tier, "priority", "the paused tier is not retried");
  assert.equal(sent.length, 3);
});

test("unrelated errors are never retried or blamed on the speed", async () => {
  const sol = builtin("openai", "gpt-6.1-sol");
  let calls = 0;
  const fallbacks = new FastFallbacks();
  const options = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return Response.json({ error: { message: "Invalid input item." } }, { status: 400 });
      },
    },
    async () => "fast",
    { fallbacks },
  );
  const message = await openaiStream(
    sol as Model<"openai-responses">,
    transcript(),
    options,
  ).result();
  assert.equal(message.stopReason, "error");
  assert.equal(calls, 1);
  assert.equal(fallbacks.blocked(sol, "fast"), undefined);
});

test("real Anthropic requests send speed, the beta where required, and fall back on 429", async () => {
  for (const id of ["claude-opus-5-5", "claude-opus-5"]) {
    const claude = builtin("anthropic", id);
    const sent: Array<{ body: Record<string, unknown>; beta: string | null }> = [];
    const fallbacks = new FastFallbacks();
    const journal = new FastRequestJournal();
    let limited = true;
    const options = withFastPayload<StreamOptions>(
      {
        apiKey: "sk-ant-test",
        maxRetries: 0,
        fetch: async (_input, init) => {
          const request = body(init);
          sent.push({ body: request, beta: new Headers(init?.headers).get("anthropic-beta") });
          if (request.speed === "fast" && limited) {
            limited = false;
            return Response.json(
              { type: "error", error: { type: "rate_limit_error", message: "Fast limit" } },
              { status: 429, headers: { "retry-after": "30" } },
            );
          }
          return sse(anthropicDone(request.speed === "fast" ? "fast" : "standard"));
        },
      },
      async () => "fast",
      { journal, fallbacks },
    );
    const message = await anthropicStream(
      claude as Model<"anthropic-messages">,
      transcript(),
      options,
    ).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    assert.equal(sent[0]?.body.speed, "fast", id);
    assert.equal(sent[0]?.beta?.includes(ANTHROPIC_FAST_BETA) ?? false, id === "claude-opus-5", id);
    assert.equal(sent[1]?.body.speed, undefined, `${id} retries at standard speed`);
    assert.equal(journal.last?.responseTier, "standard");
    const block = fallbacks.blocked(claude, "fast");
    assert.ok(block?.until, "a rate limit cools down instead of disabling Fast");
  }
});

test("Anthropic reports usage.speed from the stream", async () => {
  const claude = builtin("anthropic", "claude-fable-5-2");
  const journal = new FastRequestJournal();
  const options = withFastPayload<StreamOptions>(
    { apiKey: "sk-ant-test", fetch: async () => sse(anthropicDone("fast")) },
    async () => "ultrafast",
    { journal },
  );
  const message = await anthropicStream(
    claude as Model<"anthropic-messages">,
    transcript(),
    options,
  ).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(journal.last?.appliedSpeed, "fast", "Claude has no Ultrafast; Fast applies");
  assert.equal(journal.last?.requestedTier, "fast");
  assert.equal(journal.last?.responseTier, "fast");
});

test("compressed Codex bodies are rebuilt for the fallback retry", async () => {
  const sol = codexModel("gpt-6.1-sol");
  const capability = {
    status: "supported",
    ultrafast: "supported",
    ultrafastTier: "ultrafast",
    source: "catalog",
    reason: "test",
  } as const;
  const sent: Array<Record<string, unknown>> = [];
  const fallbacks = new FastFallbacks();
  const options = withFastPayload<StreamOptions>(
    {
      apiKey: token(),
      fetch: async (_input, init) => {
        const request = body(init);
        sent.push(request);
        return request.service_tier === "ultrafast"
          ? Response.json({ detail: "Unsupported service_tier: ultrafast" }, { status: 400 })
          : sse(openaiDone("priority"));
      },
    },
    async () => "ultrafast",
    { fallbacks, resolveCapability: () => capability },
  );
  // Exercise the fetch wrapper directly with a zstd body, as Pi's Codex transport sends.
  const hook = options.onPayload!;
  await hook.call(options, { model: sol.id }, sol);
  const response = await options.fetch!("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-encoding": "zstd", "content-length": "1" },
    body: new Uint8Array(
      zstdCompressSync(JSON.stringify({ model: sol.id, service_tier: "ultrafast" })),
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    sent.map((request) => request.service_tier),
    ["ultrafast", "priority"],
  );
});

test("Pi's own route (runtime.streamSimple) carries speeds, fallbacks and reported tiers", async (t) => {
  const piRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(piRuntime);
  const journal = new FastRequestJournal();
  const fallbacks = new FastFallbacks();
  const remove = installFastModeProviderLookup(registry, async () => "ultrafast", {
    journal,
    fallbacks,
  });
  t.after(remove);

  // Wrapped providers keep optional members newer Pi versions rely on.
  const openaiProvider = registry.getProvider("openai")!;
  assert.equal(isFastModeProvider(openaiProvider), true);
  assert.equal(typeof openaiProvider.filterAllModels, "function");
  assert.equal(typeof openaiProvider.getAllModels, "function");
  assert.equal(openaiProvider.id, "openai");
  assert.ok(Object.keys(openaiProvider).includes("streamSimple"));

  const sol = piRuntime.getModel("openai", "gpt-6.1-sol")!;
  const tiers: unknown[] = [];
  const openai = await piRuntime
    .streamSimple(sol, transcript(), {
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_input, init) => {
        const request = body(init);
        tiers.push(request.service_tier);
        return request.service_tier === "ultrafast"
          ? Response.json(
              { error: { message: "service_tier ultrafast is not allowed" } },
              { status: 403 },
            )
          : sse(openaiDone("priority"));
      },
    })
    .result();
  assert.equal(openai.stopReason, "stop", openai.errorMessage);
  assert.deepEqual(tiers, ["ultrafast", "priority"]);
  assert.equal(journal.last?.responseTier, "priority");
  assert.equal(journal.last?.fellBackTo, "fast");

  const claude = piRuntime.getModel("anthropic", "claude-opus-5-5")!;
  const speeds: unknown[] = [];
  const anthropic = await piRuntime
    .streamSimple(claude, transcript(), {
      apiKey: "sk-ant-test",
      maxRetries: 0,
      fetch: async (_input, init) => {
        const request = body(init);
        speeds.push(request.speed);
        return sse(anthropicDone("fast"));
      },
    })
    .result();
  assert.equal(anthropic.stopReason, "stop", anthropic.errorMessage);
  assert.deepEqual(speeds, ["fast"]);
  assert.equal(journal.last?.responseTier, "fast");
});

test("fallbacks: stepwise, explicit standard, beta removal, pricing and no blame for other errors", async () => {
  const sol = builtin("openai", "gpt-6.1-sol");
  const sent: Array<Record<string, unknown>> = [];
  const fallbacks = new FastFallbacks();
  const journal = new FastRequestJournal();
  const options = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async (_input, init) => {
        const request = body(init);
        sent.push(request);
        if (request.service_tier !== "default")
          return Response.json(
            { error: { message: "Not allowed.", param: "service_tier" } },
            { status: 400 },
          );
        return sse(openaiDone("default"));
      },
    },
    async () => "ultrafast",
    { journal, fallbacks },
  );
  const message = await openaiStream(
    sol as Model<"openai-responses">,
    transcript(),
    options,
  ).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.deepEqual(
    sent.map((request) => request.service_tier),
    ["ultrafast", "priority", "default"],
  );
  assert.ok(fallbacks.blocked(sol, "ultrafast"));
  assert.ok(fallbacks.blocked(sol, "fast"));
  assert.equal(journal.last?.fellBackTo, "standard");
  assert.equal(journal.last?.appliedSpeed, undefined);
  assert.equal(journal.last?.requestedTier, "default");
  assert.equal(message.usage.cost.total > 0, true);
  const standardCost = (sol.cost.input * message.usage.input) / 1_000_000;
  assert.ok(
    Math.abs(message.usage.cost.input - standardCost) < 1e-12,
    "Pi's cost estimate uses the standard tier after the fallback",
  );

  // A tool or field named "speed" is not the speed setting.
  const unrelated = new FastFallbacks();
  let calls = 0;
  const schema = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-test",
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return Response.json(
          {
            error: {
              message: "Invalid schema for function 'speed': missing type.",
              param: "tools[0]",
            },
          },
          { status: 400 },
        );
      },
    },
    async () => "fast",
    { fallbacks: unrelated },
  );
  const failed = await openaiStream(
    sol as Model<"openai-responses">,
    transcript(),
    schema,
  ).result();
  assert.equal(failed.stopReason, "error");
  assert.equal(calls, 1);
  assert.equal(unrelated.blocked(sol, "fast"), undefined);
});

test("Anthropic: the Fast beta leaves on a standard retry, overloads stay with Pi, retries keep the downgrade", async () => {
  const opus5 = builtin("anthropic", "claude-opus-5");
  const sent: Array<{ speed: unknown; beta: string | null }> = [];
  const fallbacks = new FastFallbacks();
  const options = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-ant-test",
      maxRetries: 0,
      headers: { "anthropic-beta": "other-beta" },
      fetch: async (_input, init) => {
        const request = body(init);
        const beta = new Headers(init?.headers).get("anthropic-beta");
        sent.push({ speed: request.speed, beta });
        if (beta?.includes(ANTHROPIC_FAST_BETA))
          return Response.json(
            {
              type: "error",
              error: { type: "rate_limit_error", message: "Fast mode rate limit reached." },
            },
            { status: 429 },
          );
        return sse(anthropicDone("standard"));
      },
    },
    async () => "fast",
    { fallbacks },
  );
  const message = await anthropicStream(
    opus5 as Model<"anthropic-messages">,
    transcript(),
    options,
  ).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(sent.length, 2);
  assert.ok(sent[0]?.beta?.includes(ANTHROPIC_FAST_BETA));
  assert.equal(sent[1]?.speed, undefined);
  assert.equal(sent[1]?.beta, "other-beta", "other betas stay");

  // A provider retry resends the original Fast body without rerunning the payload hook;
  // the pause lowers it before sending.
  await options.fetch!("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "anthropic-beta": `other-beta,${ANTHROPIC_FAST_BETA}` },
    body: JSON.stringify({ model: opus5.id, speed: "fast" }),
  });
  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.speed, undefined);
  assert.equal(sent[2]?.beta, "other-beta");

  // General overload is Pi's to retry, not a Fast refusal.
  const claude = builtin("anthropic", "claude-opus-5-5");
  const overloaded = new FastFallbacks();
  let calls = 0;
  const busy = withFastPayload<StreamOptions>(
    {
      apiKey: "sk-ant-test",
      maxRetries: 0,
      fetch: async () => {
        calls++;
        return Response.json(
          { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
          { status: 529 },
        );
      },
    },
    async () => "fast",
    { fallbacks: overloaded },
  );
  const result = await anthropicStream(
    claude as Model<"anthropic-messages">,
    transcript(),
    busy,
  ).result();
  assert.equal(result.stopReason, "error");
  assert.equal(calls, 1);
  assert.equal(overloaded.blocked(claude, "fast"), undefined);
});

test("metadata, preference and decorator edge cases", async (t) => {
  // null is malformed, not absent: no paid request on a guess.
  const astra = codexModel("gpt-6-astra");
  assert.equal(
    resolveFastCapability({ ...astra, service_tiers: null } as Model<Api>).status,
    "unknown",
  );

  const journal = new FastRequestJournal();
  const gatewayModel = builtin("vercel-ai-gateway", "anthropic/claude-opus-5.5");
  const observation = journal.begin(
    gatewayModel,
    "fast",
    {},
    "fast",
    resolveFastCapability(gatewayModel),
  );
  observation.event({
    type: "message_delta",
    provider_metadata: { gateway: { routing: { speed: "fast" } } },
  });
  assert.equal(journal.last?.responseTier, "fast");
  observation.event({
    type: "message_stop",
    providerMetadata: { gateway: { serviceTier: "ultrafast" } },
  });
  assert.equal(journal.last?.responseTier, "ultrafast");

  const root = await mkdtemp(join(tmpdir(), "fast-speeds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fast-mode.json");
  await setFastSpeed("ultrafast", path);
  assert.equal(await setFastMode(true, path), true);
  assert.equal(await loadFastSpeed(path), "ultrafast", "on keeps a stored Ultrafast preference");

  const piRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(piRuntime);
  const remove = installFastModeProviderLookup(registry, async () => "off");
  t.after(remove);
  const provider = registry.getProvider("anthropic")! as unknown as Record<string, unknown>;
  provider.extensionHook = 1;
  assert.equal(provider.extensionHook, 1, "writes reach the provider");
  assert.equal(isFastModeProvider({ ...provider } as never), true, "spread copies stay recognized");
});
