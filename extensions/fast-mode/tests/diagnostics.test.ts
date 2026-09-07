import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { FastRequestJournal } from "../diagnostics.ts";
import { CodexCapabilities, resolveFastCapability } from "../capabilities.ts";
import { installFastModeProviderLookup } from "../runtime.ts";
import { formatFastDetails } from "../footer.ts";
import { withFastPayload } from "../policy.ts";
import { catalog, model, token } from "./helpers.ts";

function sse(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function done(tier: string): string {
  return `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "test-response",
      status: "completed",
      service_tier: tier,
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    },
  })}\n\n`;
}

test("real Codex stream and streamSimple send Astra priority and expose raw SSE tier, not pricing inference", async () => {
  for (const simple of [false, true]) {
    let payload: Record<string, unknown> | undefined;
    let responseCalls = 0;
    const journal = new FastRequestJournal();
    const options = withFastPayload<StreamOptions>(
      {
        apiKey: token(),
        transport: "sse",
        onPayload: (body) => ({ ...(body as object), marker: true }),
        onResponse: () => {
          responseCalls++;
        },
        fetch: async (_input, init) => {
          const compressed = new Headers(init?.headers).get("content-encoding") === "zstd";
          const bytes = init?.body as Uint8Array;
          payload = JSON.parse(
            compressed ? zstdDecompressSync(bytes).toString() : String(init?.body),
          );
          return sse(done("default"));
        },
      },
      async () => true,
      { journal },
    );
    const context = { systemPrompt: "DO NOT RETAIN THIS PROMPT", messages: [] };
    const response = await (
      simple
        ? streamSimple(model(), context, { ...options, reasoning: "xhigh" })
        : stream(model(), context, { ...options, reasoningEffort: "xhigh" })
    ).result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert.equal(payload?.service_tier, "priority");
    assert.deepEqual(payload?.reasoning, { effort: "xhigh", summary: "auto" });
    assert.equal(payload?.marker, true);
    assert.equal(responseCalls, 1);
    assert.equal(journal.last?.applied, true);
    assert.equal(journal.last?.requestedTier, "priority");
    assert.equal(journal.last?.responseTier, "default");
    assert.equal(journal.last?.observedTransport, "sse");
    assert.ok(journal.last?.completedMs !== undefined);
    const serialized = JSON.stringify(journal.last);
    assert.doesNotMatch(serialized, /DO NOT RETAIN|authorization|test-account|Bearer/);
    assert.doesNotMatch(serialized, new RegExp(token().replaceAll(".", "\\.")));
    assert.match(
      formatFastDetails({ enabled: true }, model(), resolveFastCapability(model()), journal.last),
      /not independent proof/,
    );
  }
});

test("SSE tap preserves split CRLF and UTF-8 bytes, ignoring malformed and oversized frames", async () => {
  let now = 100;
  const journal = new FastRequestJournal(
    () => {},
    () => now,
  );
  const observation = journal.begin(
    model(),
    { service_tier: "priority" },
    {},
    true,
    resolveFastCapability(model()),
  );
  now = 150;
  const text =
    "data: not-json\r\n\r\n" +
    `data: ${JSON.stringify({ type: "irrelevant", output: "大".repeat(70_000) })}\r\n\r\n` +
    'data: {"type":"response.output_text.delta","delta":"⚡"}\r\n\r\n' +
    done("priority");
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 997, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const observed = observation.response(response);
  assert.deepEqual(new Uint8Array(await observed.arrayBuffer()), bytes);
  assert.equal(journal.last?.responseTier, "priority");
  assert.equal(journal.last?.firstOutputMs, 50);
});

test("observer forwards cancellation and never invents WebSocket confirmation", async () => {
  let cancelled = false;
  const journal = new FastRequestJournal();
  const options = withFastPayload<StreamOptions>({ transport: "auto" }, async () => true, {
    journal,
  });
  await options.onPayload?.({ model: model().id }, model());
  assert.equal(journal.last?.responseTier, undefined);
  assert.equal(journal.last?.observedTransport, "unknown");
  const observation = journal.begin(model(), {}, {}, false, resolveFastCapability(model()));
  const response = observation.response(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  await response.body?.cancel("test cancellation");
  assert.equal(cancelled, true);
});

test("out-of-order completions do not replace the newest request and UI failures cannot break streams", async () => {
  const journal = new FastRequestJournal(() => {
    throw new Error("UI disposed");
  });
  const first = journal.begin(
    model("gpt-5.5"),
    { service_tier: "priority" },
    {},
    true,
    resolveFastCapability(model()),
  );
  const second = journal.begin(
    model(),
    { service_tier: "default" },
    {},
    false,
    resolveFastCapability(model()),
  );
  await second.response(sse(done("default"))).text();
  await first.response(sse(done("priority"))).text();
  assert.equal(journal.last?.model, "gpt-6-astra");
  assert.equal(journal.last?.responseTier, "default");
});

test("live capabilities and diagnostics survive real runtime refresh and inherited child streams", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: token(),
    refresh: "test-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "test-account",
  }));
  const runtimeOptions = {
    credentials,
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  };
  const runtime = await ModelRuntime.create(runtimeOptions);
  const registry = new ModelRegistry(runtime);
  const capabilities = new CodexCapabilities(async () =>
    catalog([{ slug: "gpt-future", service_tiers: [{ id: "priority" }] }]),
  );
  await capabilities.refresh(model(), { apiKey: token() }, new AbortController().signal);
  const journal = new FastRequestJournal();
  const remove = installFastModeProviderLookup(registry, async () => true, {
    journal,
    resolveCapability: (selected, options) => capabilities.resolve(selected, options),
  });
  const payloads: Array<Record<string, unknown>> = [];
  const options: StreamOptions = {
    transport: "sse",
    fetch: async (_input, init) => {
      const compressed = new Headers(init?.headers).get("content-encoding") === "zstd";
      payloads.push(
        JSON.parse(
          compressed ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body),
        ),
      );
      return sse(done("priority"));
    },
  };
  try {
    await runtime.refresh({ allowNetwork: false });
    const response = await runtime
      .streamSimple(model("gpt-future"), { messages: [] }, options)
      .result();
    assert.equal(response.stopReason, "stop", response.errorMessage);
    assert.equal(payloads.at(-1)?.service_tier, "priority");
    assert.equal(journal.last?.capability.source, "catalog");
    assert.equal(journal.last?.responseTier, "priority");
    const child = await ModelRuntime.create(runtimeOptions);
    child.registerNativeProvider(registry.getProvider("openai-codex")!);
    const result = await child
      .streamSimple(model("gpt-future"), { messages: [] }, options)
      .result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(payloads.at(-1)?.service_tier, "priority");
    assert.equal(journal.last?.id, 2);
    remove();
    const stopped = await child
      .streamSimple(model("gpt-future"), { messages: [] }, options)
      .result();
    assert.equal(stopped.stopReason, "stop", stopped.errorMessage);
    assert.equal(payloads.at(-1)?.service_tier, undefined);
    assert.equal(journal.last?.id, 2, "teardown stops inherited diagnostics too");
  } finally {
    remove();
  }
});

test("off preserves caller tier and diagnostics; teardown during a state read cancels policy changes", async () => {
  const journal = new FastRequestJournal();
  const options = withFastPayload<StreamOptions>({}, async () => false, { journal });
  const payload = { model: model().id, service_tier: "priority" };
  assert.equal(await options.onPayload?.(payload, model()), payload);
  assert.equal(journal.last?.applied, false);
  assert.equal(journal.last?.requestedTier, "priority");
  let active = true;
  let release!: (enabled: boolean) => void;
  const waiting = withFastPayload<StreamOptions>(
    {},
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    { journal, isActive: () => active },
  );
  const pending = waiting.onPayload!({ model: model().id }, model());
  await Promise.resolve();
  active = false;
  release(true);
  assert.deepEqual(await pending, { model: model().id });
  assert.equal(journal.last?.id, 1);
});
