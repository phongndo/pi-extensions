import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
  type Provider,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { FooterComponent, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installFastModeFooterPrefix, prefixFastModeModelLine } from "../footer.ts";
import { installFastModeProviderLookup } from "../index.ts";
import {
  applyCodexFastMode,
  decorateCodexProvider,
  isFastModeProvider,
  supportsCodexFastMode,
} from "../policy.ts";
import { loadFastMode, saveFastMode, toggleFastMode } from "../state.ts";

function model(id: string, provider = "openai-codex", api: Api = "openai-codex-responses") {
  return {
    id,
    name: id,
    provider,
    api,
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
  } satisfies Model<Api>;
}

test("recognizes only supported Codex Fast models", () => {
  for (const id of [
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]) {
    assert.equal(supportsCodexFastMode(model(id)), true, id);
  }
  for (const candidate of [
    model("gpt-5.3-codex-spark"),
    model("gpt-5.4-mini"),
    model("gpt-5.5", "openai", "openai-responses"),
  ]) {
    assert.equal(supportsCodexFastMode(candidate), false, candidate.id);
  }
});

test("adds priority without changing any reasoning level", () => {
  const selected = model("gpt-5.6-sol");
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const payload = { model: selected.id, reasoning: { effort }, service_tier: "default" };
    assert.deepEqual(applyCodexFastMode(payload, selected, true), {
      model: selected.id,
      reasoning: { effort },
      service_tier: "priority",
    });
  }
});

test("leaves disabled, unsupported, and mismatched requests unchanged", () => {
  const selected = model("gpt-5.5");
  const payload = { model: selected.id };
  assert.equal(applyCodexFastMode(payload, selected, false), payload);
  assert.equal(applyCodexFastMode(payload, model("gpt-5.4-mini"), true), payload);
  const mismatched = { model: "other" };
  assert.equal(applyCodexFastMode(mismatched, selected, true), mismatched);
});

test("provider decoration composes payload hooks for child runtimes", async () => {
  let captured: StreamOptions | undefined;
  const stopped = new Error("captured");
  const provider: Provider = {
    id: "openai-codex",
    name: "Codex",
    auth: { apiKey: { name: "test", resolve: async () => undefined } },
    getModels: () => [model("gpt-5.5")],
    stream: (_model, _context, options) => {
      captured = options;
      throw stopped;
    },
    streamSimple: (_model, _context, options) => {
      // Codex streamSimple maps generic options to a distinct API options object.
      captured = { onPayload: options?.onPayload };
      throw stopped;
    },
  };
  const decorated = decorateCodexProvider(provider, async () => true);
  assert.equal(isFastModeProvider(decorated), true);
  assert.equal(
    decorateCodexProvider(decorated, async () => false),
    decorated,
  );

  const selected = model("gpt-5.5");
  assert.throws(
    () =>
      decorated.streamSimple(
        selected,
        { messages: [] },
        {
          onPayload: async (payload) => ({ ...(payload as object), marker: true }),
        },
      ),
    (error: unknown) => error === stopped,
  );
  assert.ok(captured?.onPayload);
  assert.deepEqual(await captured.onPayload({ model: selected.id }, selected), {
    model: selected.id,
    marker: true,
    service_tier: "priority",
  });
  assert.equal((captured as StreamOptions & { serviceTier?: string }).serviceTier, "priority");

  assert.throws(
    () => decorated.stream(selected, { messages: [] }, { onPayload: async () => null }),
    (error: unknown) => error === stopped,
  );
  assert.ok(captured?.onPayload);
  assert.equal(await captured.onPayload({ model: selected.id }, selected), null);

  const stateError = new Error("state read failed");
  let stateReads = 0;
  const failing = decorateCodexProvider(provider, async () => {
    stateReads += 1;
    throw stateError;
  });
  assert.throws(
    () => failing.stream(selected, { messages: [] }),
    (error: unknown) => error === stopped,
  );
  const failingPayloadHook = captured?.onPayload;
  assert.ok(failingPayloadHook);
  await assert.rejects(
    Promise.resolve(failingPayloadHook({ model: selected.id }, selected)),
    (error: unknown) => error === stateError,
  );
  assert.equal(stateReads, 1);

  const unsupported = model("gpt-5.4-mini");
  assert.throws(
    () => failing.stream(unsupported, { messages: [] }),
    (error: unknown) => error === stopped,
  );
  assert.ok(captured?.onPayload);
  const unsupportedPayload = { model: unsupported.id };
  assert.equal(await captured.onPayload(unsupportedPayload, unsupported), unsupportedPayload);
  assert.equal(stateReads, 1);

  const externallyPrioritized = decorateCodexProvider(provider, async () => false);
  assert.throws(
    () =>
      externallyPrioritized.stream(
        selected,
        { messages: [] },
        {
          onPayload: async (payload) => ({ ...(payload as object), service_tier: "priority" }),
        },
      ),
    (error: unknown) => error === stopped,
  );
  assert.ok(captured?.onPayload);
  assert.deepEqual(await captured.onPayload({ model: selected.id }, selected), {
    model: selected.id,
    service_tier: "priority",
  });
  assert.equal((captured as StreamOptions & { serviceTier?: string }).serviceTier, "priority");
});

test("active Fast provider survives a composed registry refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-provider-refresh-"));
  const modelsPath = join(root, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: "https://overlay.example.invalid" } },
    }),
  );
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });

  let captured: StreamOptions | undefined;
  let catalogRefreshed = false;
  const stopped = new Error("captured refreshed provider request");
  const base: Provider = {
    id: "openai-codex",
    name: "Codex",
    auth: {
      apiKey: {
        name: "test",
        resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
      },
    },
    getModels: () => [model("gpt-5.5")],
    refreshModels: async () => {
      catalogRefreshed = true;
    },
    stream: (_model, _context, options) => {
      captured = options;
      throw stopped;
    },
    streamSimple: (_model, _context, options) => {
      captured = options;
      throw stopped;
    },
  };
  runtime.registerNativeProvider(base);
  const registry = new ModelRegistry(runtime);
  const removeLookup = installFastModeProviderLookup(registry, async () => true);
  catalogRefreshed = false;
  await runtime.refresh({ allowNetwork: true });

  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), base);
  assert.equal(catalogRefreshed, true);
  const refreshedProvider = registry.getProvider("openai-codex");
  const selected = runtime.getModel("openai-codex", "gpt-5.5");
  assert.ok(refreshedProvider);
  assert.ok(selected);
  assert.notEqual(refreshedProvider, base);
  const result = await refreshedProvider.stream(selected, { messages: [] }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, stopped.message);
  assert.ok(captured?.onPayload);
  assert.deepEqual(await captured.onPayload({ model: selected.id }, selected), {
    model: selected.id,
    service_tier: "priority",
  });
  removeLookup();
});

test("direct runtime streams stay Fast after a built-in provider refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-builtin-refresh-"));
  const modelsPath = join(root, "models.json");
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: { "openai-codex": { baseUrl: "https://overlay.example.invalid" } },
    }),
  );
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "test-key",
    refresh: "test-refresh",
    expires: Date.now() + 60_000,
    accountId: "test-account",
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);
  const removeLookup = installFastModeProviderLookup(registry, async () => true);

  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getRegisteredNativeProvider("openai-codex"), undefined);
  const selected = runtime.getModel("openai-codex", "gpt-5.5");
  const refreshedProvider = runtime.getProvider("openai-codex");
  assert.ok(selected);
  assert.ok(refreshedProvider);
  assert.equal(isFastModeProvider(refreshedProvider), false);

  let captured: StreamOptions | undefined;
  const stopped = new Error("captured direct runtime request");
  refreshedProvider.streamSimple = (_model, _context, options) => {
    captured = options;
    throw stopped;
  };
  const result = await runtime.streamSimple(selected, { messages: [] }).result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, stopped.message);
  assert.ok(captured?.onPayload);
  assert.deepEqual(await captured.onPayload({ model: selected.id }, selected), {
    model: selected.id,
    service_tier: "priority",
  });
  removeLookup();
});

test("shared runtime wrappers support out-of-order session teardown", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider("openai-codex");
  assert.ok(provider);
  const originalRuntimeStream = runtime.stream;
  const originalProviderStream = provider.stream;
  const removeFirst = installFastModeProviderLookup(new ModelRegistry(runtime), async () => true);
  const removeSecond = installFastModeProviderLookup(new ModelRegistry(runtime), async () => true);

  assert.notEqual(runtime.stream, originalRuntimeStream);
  assert.equal(provider.stream, originalProviderStream);
  removeFirst();
  assert.notEqual(runtime.stream, originalRuntimeStream);
  assert.equal(provider.stream, originalProviderStream);
  removeSecond();
  assert.equal(runtime.stream, originalRuntimeStream);
  assert.equal(provider.stream, originalProviderStream);
});

test("a retained outer runtime wrapper stays safe after Fast teardown", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const removeLookup = installFastModeProviderLookup(new ModelRegistry(runtime), async () => true);
  const fastStream = runtime.stream;
  const outerStream: ModelRuntime["stream"] = (model, context, options) =>
    fastStream.call(runtime, model, context, options);
  runtime.stream = outerStream;
  removeLookup();

  assert.equal(runtime.stream, outerStream);
  const selected = runtime.getModel("openai-codex", "gpt-5.5");
  assert.ok(selected);
  assert.doesNotThrow(() => runtime.stream(selected, { messages: [] }));
});

test("Fast provider lookup supports immutable native providers", async () => {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  let captured: StreamOptions | undefined;
  const stopped = new Error("immutable provider request");
  const immutableProvider = Object.freeze({
    id: "openai-codex",
    name: "Immutable Codex",
    auth: { apiKey: { name: "test", resolve: async () => undefined } },
    getModels: () => [model("gpt-5.5")],
    stream: (_model, _context, options) => {
      captured = options;
      throw stopped;
    },
    streamSimple: (_model, _context, options) => {
      captured = options;
      throw stopped;
    },
  } satisfies Provider);
  runtime.registerNativeProvider(immutableProvider);
  const registry = new ModelRegistry(runtime);
  const removeLookup = installFastModeProviderLookup(registry, async () => true);

  const decorated = registry.getRegisteredNativeProvider("openai-codex");
  assert.ok(decorated);
  assert.notEqual(decorated, immutableProvider);
  assert.equal(isFastModeProvider(decorated), true);
  assert.equal(
    immutableProvider.stream,
    runtime.getRegisteredNativeProvider("openai-codex")?.stream,
  );
  removeLookup();

  const selected = model("gpt-5.5");
  assert.throws(
    () => decorated.stream(selected, { messages: [] }),
    (error: unknown) => error === stopped,
  );
  assert.ok(captured?.onPayload);
  const payload = { model: selected.id };
  assert.equal(await captured.onPayload(payload, selected), payload);
});

test("prefixes the supported model in the built-in footer without changing its width", () => {
  const lines = [
    "~/project (main)",
    "$0.000 (sub) 0.1%/272k (auto)    (openai-codex) gpt-5.6-sol • xhigh",
  ];
  const prefixed = prefixFastModeModelLine(lines, model("gpt-5.6-sol"), true);

  assert.deepEqual(prefixed, [
    lines[0],
    "$0.000 (sub) 0.1%/272k (auto)  (openai-codex) ϟ gpt-5.6-sol • xhigh",
  ]);
  assert.equal(prefixed[1]?.length, lines[1]?.length);
  assert.equal(prefixFastModeModelLine(lines, model("gpt-5.6-sol"), false), lines);
  assert.equal(prefixFastModeModelLine(lines, model("gpt-5.4-mini"), true), lines);
});

test("decorates only the built-in footer prototype and restores it on teardown", () => {
  const originalRender = FooterComponent.prototype.render;
  const removeFirst = installFastModeFooterPrefix(() => true);
  const decoratedRender = FooterComponent.prototype.render;
  const removeSecond = installFastModeFooterPrefix(() => true);

  assert.notEqual(decoratedRender, originalRender);
  assert.equal(FooterComponent.prototype.render, decoratedRender);
  removeFirst();
  assert.equal(FooterComponent.prototype.render, decoratedRender);
  removeSecond();
  assert.equal(FooterComponent.prototype.render, originalRender);
});

test("persists the global toggle atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-"));
  const path = join(root, "fast-mode.json");
  assert.equal(await loadFastMode(path), false);
  await saveFastMode(true, path);
  assert.equal(await loadFastMode(path), true);
  await saveFastMode(false, path);
  assert.equal(await loadFastMode(path), false);

  assert.deepEqual((await Promise.all([toggleFastMode(path), toggleFastMode(path)])).sort(), [
    false,
    true,
  ]);
  assert.equal(await loadFastMode(path), false);

  await writeFile(path, "{}", "utf8");
  await assert.rejects(loadFastMode(path), /Invalid fast-mode state/);
});

test("reclaims an abandoned lock after its PID is recycled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-recycled-pid-"));
  const path = join(root, "fast-mode.json");
  const abandonedLockPath = `${path}.lock`;
  await mkdir(abandonedLockPath);
  await writeFile(
    join(abandonedLockPath, "owner.json"),
    JSON.stringify({
      version: 2,
      pid: process.pid,
      createdAt: Date.now(),
      token: "abandoned",
      processStartId: "a-different-process-instance",
    }),
  );

  assert.equal(await toggleFastMode(path), true);
  assert.equal(await loadFastMode(path), true);
});

test("reclaims an expired lock from a foreign host", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-foreign-host-"));
  const path = join(root, "fast-mode.json");
  const abandonedLockPath = `${path}.lock`;
  const token = "foreign-owner";
  const markerPath = join(abandonedLockPath, `owner.${token}.json`);
  await mkdir(abandonedLockPath);
  await writeFile(
    markerPath,
    JSON.stringify({
      version: 3,
      pid: process.pid,
      createdAt: Date.now() - 10 * 60_000,
      token,
      processStartId: "foreign-process-instance",
      hostId: "a-different-host",
    }),
  );
  const expired = new Date(Date.now() - 10 * 60_000);
  await utimes(markerPath, expired, expired);
  await utimes(abandonedLockPath, expired, expired);

  assert.equal(await toggleFastMode(path), true);
  assert.equal(await loadFastMode(path), true);
});

test("reclaims abandoned lock directories with multiple markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-multiple-markers-"));
  const path = join(root, "fast-mode.json");
  const abandonedLockPath = `${path}.lock`;
  await mkdir(abandonedLockPath);
  await Promise.all(
    ["abandoned-a", "abandoned-b"].map((token) =>
      writeFile(
        join(abandonedLockPath, `owner.${token}.json`),
        JSON.stringify({
          version: 2,
          pid: process.pid,
          createdAt: Date.now(),
          token,
          processStartId: "a-different-process-instance",
        }),
      ),
    ),
  );

  assert.equal(await toggleFastMode(path), true);
  assert.equal(await loadFastMode(path), true);
});

test("serializes contenders racing to reclaim an abandoned lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fast-mode-stale-lock-"));
  const path = join(root, "fast-mode.json");
  const abandonedLockPath = `${path}.lock`;
  const exitedOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const exitedOwnerPid = exitedOwner.pid;
  assert.ok(exitedOwnerPid);
  await once(exitedOwner, "exit");

  await mkdir(abandonedLockPath);
  await writeFile(
    join(abandonedLockPath, "owner.json"),
    JSON.stringify({
      version: 1,
      pid: exitedOwnerPid,
      createdAt: Date.now(),
      token: "abandoned",
    }),
  );

  assert.deepEqual((await Promise.all([toggleFastMode(path), toggleFastMode(path)])).sort(), [
    false,
    true,
  ]);
  assert.equal(await loadFastMode(path), false);
});
