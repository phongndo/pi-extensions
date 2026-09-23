import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveFastCapability } from "../capabilities.ts";
import { FAST_MODE_STATUS_KEY } from "../footer.ts";
import { createFastModeExtension } from "../index.ts";
import { FastModeRoutes } from "../routes.ts";

const endpoint = "http://127.0.0.1:8317/v1";
const proxyRoute = { provider: "local-codex", baseUrl: endpoint };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function harness(routes: unknown = { version: 1, routes: [proxyRoute] }) {
  const root = await mkdtemp(join(tmpdir(), "fast-proxy-"));
  const statePath = join(root, "fast-mode.json");
  const modelsPath = join(root, "models.json");
  if (routes !== null)
    await writeFile(join(root, "fast-mode-proxies.json"), JSON.stringify(routes));
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        "local-codex": {
          api: "openai-responses",
          baseUrl: endpoint,
          apiKey: "fake-test-key",
          models: ["gpt-6-astra", "gpt-6-luna", "gpt-6-sol"].map((id) => ({
            id,
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh" },
          })),
        },
      },
    }),
  );
  const runtimeOptions = {
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath,
    allowModelNetwork: false,
  };
  const runtime = await ModelRuntime.create(runtimeOptions);
  const registry = new ModelRegistry(runtime);
  let discoveryAuthCalls = 0;
  registry.getApiKeyAndHeaders = async () => {
    discoveryAuthCalls++;
    throw new Error("Proxy discovery must not even resolve account credentials");
  };
  const selected = runtime.getModel("local-codex", "gpt-6-astra")!;
  assert.ok(selected);
  const notifications: string[] = [];
  const statuses = new Map<string, string>();
  const handlers = new Map<string, Handler>();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  let discoveryCalls = 0;
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: selected,
    modelRegistry: registry,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (key: string, value?: string) => {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, value: typeof command) => {
      command = value;
    },
  } as unknown as ExtensionAPI;
  createFastModeExtension({
    statePath,
    discovery: true,
    fetchCatalog: async () => {
      discoveryCalls++;
      throw new Error("Proxy credentials must never reach discovery");
    },
  })(api);
  const emit = async (name: string) => {
    await handlers.get(name)?.({}, ctx);
  };
  const payloads: Array<Record<string, unknown>> = [];
  const options: StreamOptions = {
    apiKey: "fake-test-key",
    fetch: async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_test",
            status: "completed",
            service_tier: "default",
            output: [],
            usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  };
  return {
    root,
    runtimeOptions,
    runtime,
    registry,
    selected,
    ctx,
    notifications,
    statuses,
    payloads,
    options,
    emit,
    command: (args: string) => command.handler(args, ctx as ExtensionCommandContext),
    get discoveryCalls() {
      return discoveryCalls;
    },
    get discoveryAuthCalls() {
      return discoveryAuthCalls;
    },
    async close() {
      await emit("session_shutdown");
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function completed(result: ReturnType<ModelRuntime["streamSimple"]>) {
  const message = await result.result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
}

test("opted-in proxy sends priority through real Responses serialization, follows /fast, and reports unverified admission", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  await completed(
    app.runtime.streamSimple(
      app.selected,
      { messages: [] },
      { ...app.options, reasoning: "xhigh" },
    ),
  );
  assert.equal(app.payloads.at(-1)?.service_tier, "priority");
  assert.deepEqual(app.payloads.at(-1)?.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "speed fast");
  await app.command("status");
  assert.match(app.notifications.at(-1)!, /proxy/i);
  assert.match(app.notifications.at(-1)!, /Requested tier: priority \(set by Fast mode\)/);
  assert.match(app.notifications.at(-1)!, /Response reports: default/);
  assert.match(app.notifications.at(-1)!, /not independent proof/);
  await app.command("refresh");
  assert.equal(app.discoveryCalls, 0);
  assert.equal(app.discoveryAuthCalls, 0);

  await app.command("off");
  await completed(app.runtime.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, undefined);
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), undefined);
  await completed(
    app.runtime.streamSimple(
      app.selected,
      { messages: [] },
      {
        ...app.options,
        onPayload: (body) => ({ ...(body as object), service_tier: "priority" }),
      },
    ),
  );
  assert.equal(app.payloads.at(-1)?.service_tier, "priority", "off preserves caller policy");
});

test("new Codex models request priority through the opted-in proxy", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  const routes = new FastModeRoutes([proxyRoute]);
  for (const id of ["gpt-6-luna", "gpt-6-sol"]) {
    const selected = app.runtime.getModel("local-codex", id)!;
    assert.ok(selected, id);
    assert.equal(selected.api, "openai-responses");
    assert.equal(routes.includes(selected), true);
    assert.equal(resolveFastCapability(selected, routes).source, "fallback");
    await completed(app.runtime.streamSimple(selected, { messages: [] }, app.options));
    assert.equal(app.payloads.at(-1)?.model, id);
    assert.equal(app.payloads.at(-1)?.service_tier, "priority", id);
  }
});

test("proxy policy survives runtime refresh and inherited child providers, then tears down", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  await app.runtime.refresh({ allowNetwork: false });
  await completed(app.runtime.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, "priority");

  const child = await ModelRuntime.create({ ...app.runtimeOptions, modelsPath: null });
  child.registerNativeProvider(app.registry.getProvider("local-codex")!);
  await completed(child.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, "priority");
  await completed(child.stream(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, "priority");
  await app.command("off");
  await completed(child.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, undefined);
  await app.command("on");
  await app.emit("session_shutdown");
  await completed(child.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, undefined);
});

test("proxy opt-in stays scoped to endpoint, API, model, and payload; does not probe credentials", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  for (const [selected, extra] of [
    [{ ...app.selected, baseUrl: "https://other.example/v1" }, {}],
    [{ ...app.selected, id: "gpt-5.4-mini" }, {}],
    [{ ...app.selected, id: "gpt-future" }, {}],
    [app.selected, { onPayload: (body) => ({ ...(body as object), model: "other" }) }],
  ] as Array<[Model<Api>, StreamOptions]>) {
    await completed(
      app.runtime.streamSimple(selected, { messages: [] }, { ...app.options, ...extra }),
    );
    assert.equal(
      app.payloads.at(-1)?.service_tier,
      undefined,
      JSON.stringify({ model: selected.id, baseUrl: selected.baseUrl, extra }),
    );
  }
  await app.command("refresh");
  assert.equal(app.discoveryCalls, 0);
});

test("without proxy opt-in, existing exclusion and unavailable UI remain", async (t) => {
  for (const routes of [null, { version: 1, routes: [] }]) {
    const app = await harness(routes);
    t.after(() => app.close());
    const original = app.registry.getProvider("local-codex");
    await app.emit("session_start");
    assert.equal(app.registry.getProvider("local-codex"), original);
    await app.command("on");
    await completed(app.runtime.streamSimple(app.selected, { messages: [] }, app.options));
    assert.equal(app.payloads.at(-1)?.service_tier, undefined);
    assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "speed unavailable");
  }
});

test("runtime-resolved auth endpoint changes are checked before injecting proxy priority", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  const getAuth = app.runtime.getAuth.bind(app.runtime);
  app.runtime.getAuth = async (selected, overrides) => {
    const resolved =
      typeof selected === "string"
        ? await getAuth(selected, overrides)
        : await getAuth(selected, overrides);
    return (
      resolved && { ...resolved, auth: { ...resolved.auth, baseUrl: "https://other.example/v1" } }
    );
  };
  await completed(app.runtime.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, undefined);
});

test("proxy route changes take effect on session reload without changing the global preference", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await app.emit("session_start");
  await app.command("on");
  await writeFile(
    join(app.root, "fast-mode-proxies.json"),
    JSON.stringify({ version: 1, routes: [] }),
  );
  await app.emit("session_shutdown");
  await app.emit("session_start");
  await app.command("status");
  assert.match(app.notifications.at(-1)!, /^fast on · unavailable for this model \(global\)/);
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "speed unavailable");
  await completed(app.runtime.streamSimple(app.selected, { messages: [] }, app.options));
  assert.equal(app.payloads.at(-1)?.service_tier, undefined);
});

test("invalid route configuration reports a policy error without installing decorators", async (t) => {
  const app = await harness({
    version: 1,
    routes: [{ provider: "local-codex", baseUrl: "https://user:secret@example.com" }],
  });
  t.after(() => app.close());
  const original = app.runtime.streamSimple;
  await app.emit("session_start");
  assert.equal(app.runtime.streamSimple, original);
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "speed !");
  assert.match(app.notifications.join("\n"), /proxy/i);
  assert.doesNotMatch(app.notifications.join("\n"), /secret/);
});
