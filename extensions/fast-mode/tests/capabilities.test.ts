import assert from "node:assert/strict";
import test from "node:test";
import type { StreamOptions } from "@earendil-works/pi-ai";
import {
  CodexCapabilities,
  capabilityFromMetadata,
  codexModelsUrl,
  resolveFastCapability,
} from "../capabilities.ts";
import { withFastPayload } from "../policy.ts";
import { catalog, model, token } from "./helpers.ts";

const signal = () => new AbortController().signal;
const fast = (slug: string) => ({ slug, service_tiers: [{ id: "priority" }] });

test("metadata handles modern, legacy, negative, missing and malformed capabilities", () => {
  for (const value of [
    { service_tiers: [{ id: "priority" }] },
    { service_tiers: [{ id: "fast" }] },
    { additional_speed_tiers: ["fast"] },
  ])
    assert.equal(capabilityFromMetadata(value, "model")?.status, "supported");
  assert.equal(capabilityFromMetadata({ service_tiers: [] }, "catalog")?.status, "unsupported");
  assert.equal(capabilityFromMetadata({}, "catalog"), undefined);
  assert.equal(capabilityFromMetadata({ service_tiers: "priority" }, "catalog")?.status, "unknown");
  assert.equal(capabilityFromMetadata({ service_tiers: [null] }, "catalog")?.status, "unknown");
  assert.equal(
    resolveFastCapability({ ...model(), service_tiers: [] } as ReturnType<typeof model>).status,
    "unsupported",
  );
  assert.equal(resolveFastCapability(model("gpt-5.6-unreleased")).status, "unknown");
  assert.equal(resolveFastCapability({ ...model(), provider: "openai" }).status, "unsupported");
});

test("catalog discovery stays on the official endpoint, with no redirects or unrelated headers", async () => {
  let calls = 0;
  const cache = new CodexCapabilities(async (input, init) => {
    calls++;
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/models?client_version=0.85.1",
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token()}`);
    assert.equal(headers.get("chatgpt-account-id"), "test-account");
    assert.equal(headers.get("x-private-data"), null);
    return catalog([fast("gpt-future"), { slug: "gpt-6-astra", service_tiers: [] }]);
  });
  const auth = { apiKey: token(), headers: { "x-private-data": "must-not-leak" } };
  await cache.refresh(model(), auth, signal());
  assert.equal(cache.resolve(model("gpt-future"), auth).status, "supported");
  assert.equal(cache.resolve(model(), auth).status, "unsupported");
  assert.equal(
    cache.resolve(model("gpt-future"), { apiKey: token("different-account") }).status,
    "unknown",
  );
  assert.equal(cache.resolve(model("gpt-future")).status, "unknown");
  assert.equal(
    cache.resolve({ ...model("gpt-future"), baseUrl: "https://proxy.example" }, auth).status,
    "unknown",
  );
  await cache.refresh(model(), auth, signal());
  assert.equal(calls, 1);
  for (const baseUrl of [
    "http://chatgpt.com/backend-api",
    "https://chatgpt.com.evil.test/backend-api",
    "https://chatgpt.com/other",
    "https://user:pass@chatgpt.com/backend-api",
    "https://chatgpt.com/backend-api?redirect=1",
    "https://proxy.example",
  ]) {
    assert.equal(codexModelsUrl(baseUrl), undefined, baseUrl);
    await cache.refresh({ ...model(), baseUrl }, auth, signal());
  }
  assert.equal(calls, 1);
});

test("live catalog policy reaches the actual payload hook without a network lookup there", async () => {
  let calls = 0;
  const cache = new CodexCapabilities(async () => {
    calls++;
    return catalog([fast("gpt-future"), { slug: "gpt-6-astra", service_tiers: [] }]);
  });
  const auth = { apiKey: token() };
  await cache.refresh(model(), auth, signal());
  const options = withFastPayload<StreamOptions>(auth, async () => true, {
    resolveCapability: (selected, request) => cache.resolve(selected, request),
  });
  assert.deepEqual(
    await options.onPayload?.(
      { model: "gpt-future", reasoning: { effort: "max" } },
      model("gpt-future"),
    ),
    {
      model: "gpt-future",
      reasoning: { effort: "max" },
      service_tier: "priority",
    },
  );
  const denied = { model: "gpt-6-astra" };
  assert.equal(await options.onPayload?.(denied, model()), denied);
  assert.equal(calls, 1);
});

test("cache expiry, changed credentials, and errors fail safely without credential leaks", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const cache = new CodexCapabilities(
    async () => {
      calls++;
      if (fail) throw new Error("Bearer DO-NOT-LOG");
      return catalog([fast("gpt-future")]);
    },
    () => now,
  );
  const auth = { apiKey: token() };
  await cache.refresh(model(), auth, signal());
  now = 16 * 60_000;
  assert.equal(cache.resolve(model("gpt-future"), auth).status, "unknown");
  fail = true;
  await cache.refresh(model(), auth, signal());
  assert.doesNotMatch(cache.error ?? "", /DO-NOT-LOG/);
  await cache.refresh(model(), auth, signal());
  assert.equal(calls, 2, "failed discovery is throttled");
  fail = false;
  const other = { apiKey: token("other") };
  await cache.refresh(model(), other, signal());
  assert.equal(calls, 3);
  assert.equal(cache.resolve(model("gpt-future"), auth).status, "unknown");
  assert.equal(cache.resolve(model("gpt-future"), other).status, "supported");
});

test("late catalog responses cannot replace a newer credential scope", async () => {
  let release!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const cache = new CodexCapabilities(async () =>
    ++calls === 1 ? first : catalog([fast("gpt-new")]),
  );
  const oldAuth = { apiKey: token("old") };
  const newAuth = { apiKey: token("new") };
  const old = cache.refresh(model(), oldAuth, signal());
  await Promise.resolve();
  await cache.refresh(model(), newAuth, signal());
  release(catalog([fast("gpt-old")]));
  await old;
  assert.equal(cache.resolve(model("gpt-old"), oldAuth).status, "unknown");
  assert.equal(cache.resolve(model("gpt-new"), newAuth).status, "supported");
});

test("forced refresh supersedes an aborted pending request and clear rejects late publication", async () => {
  let release!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const cache = new CodexCapabilities(async () =>
    ++calls === 1 ? first : catalog([fast("gpt-new")]),
  );
  const auth = { apiKey: token() };
  const controller = new AbortController();
  const old = cache.refresh(model(), auth, controller.signal);
  await Promise.resolve();
  controller.abort();
  await cache.refresh(model(), auth, signal(), true);
  assert.equal(cache.resolve(model("gpt-new"), auth).status, "supported");
  cache.clear();
  release(catalog([fast("gpt-old")]));
  await old;
  assert.equal(cache.resolve(model("gpt-old"), auth).status, "unknown");
});

test("invalid and oversized catalogs never enable unknown models", async () => {
  for (const response of [
    Response.json({ other: [] }),
    new Response("not json"),
    new Response("x".repeat(4 * 1024 * 1024 + 1)),
    new Response("private body", { status: 403 }),
  ]) {
    const cache = new CodexCapabilities(async () => response);
    const auth = { apiKey: token() };
    await cache.refresh(model(), auth, signal());
    assert.ok(cache.error);
    assert.equal(cache.resolve(model("gpt-future"), auth).status, "unknown");
    assert.equal(cache.resolve(model(), auth).source, "fallback");
  }
});
