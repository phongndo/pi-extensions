import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { CodexCapabilities, resolveFastCapability } from "../capabilities.ts";
import { withFastPayload } from "../policy.ts";
import { FastModeRoutes, NATIVE_FAST_ROUTES, loadFastProxyRoutes } from "../routes.ts";
import { catalog, model } from "./helpers.ts";

const route = { provider: "local-codex", baseUrl: "http://127.0.0.1:8317/v1" };
const proxy: Model<Api> = { ...model(), ...route, api: "openai-responses" };

test("routes require opt-in and match exact provider, Responses API, and normalized endpoint", () => {
  const routes = new FastModeRoutes([route]);
  assert.equal(NATIVE_FAST_ROUTES.includes(proxy), false);
  assert.equal(routes.includes(proxy), true);
  assert.equal(routes.includes({ ...proxy, baseUrl: `${route.baseUrl}/` }), true);
  assert.equal(routes.includes(model()), true, "native Codex is unchanged");
  assert.equal(routes.hasProvider("local-codex"), true);
  assert.equal(routes.hasProvider("openai-codex"), true);
  assert.equal(routes.hasProvider("other"), false);
  for (const candidate of [
    undefined,
    { ...proxy, provider: "other" },
    { ...proxy, api: "openai-completions" },
    { ...proxy, api: "openai-codex-responses" },
    { ...proxy, baseUrl: "https://127.0.0.1:8317/v1" },
    { ...proxy, baseUrl: "http://127.0.0.1:8318/v1" },
    { ...proxy, baseUrl: "http://localhost:8317/v1" },
    { ...proxy, baseUrl: "http://127.0.0.1:8317/v2" },
    { ...proxy, baseUrl: `${route.baseUrl}?token=secret` },
    { ...proxy, baseUrl: `${route.baseUrl}#fragment` },
  ])
    assert.equal(routes.includes(candidate), false);
  assert.equal(routes.includes(proxy, "https://other.example/v1"), false);
});

test("proxy capabilities share native metadata and exact-model fallback policy but never account catalogs", async () => {
  const routes = new FastModeRoutes([route]);
  assert.equal(resolveFastCapability(proxy, routes).status, "supported");
  assert.equal(resolveFastCapability({ ...proxy, id: "gpt-5.4" }, routes).status, "supported");
  assert.equal(resolveFastCapability({ ...proxy, id: "gpt-future" }, routes).status, "unknown");
  assert.equal(
    resolveFastCapability({ ...proxy, id: "gpt-5.4-mini" }, routes).status,
    "unsupported",
  );
  assert.equal(
    resolveFastCapability({ ...proxy, service_tiers: [] } as Model<Api>, routes).status,
    "unsupported",
  );
  assert.equal(
    resolveFastCapability({ ...proxy, service_tiers: "broken" } as Model<Api>, routes).status,
    "unknown",
  );
  let calls = 0;
  const capabilities = new CodexCapabilities(
    async () => {
      calls++;
      return catalog([{ slug: "gpt-future", service_tiers: [{ id: "priority" }] }]);
    },
    Date.now,
    routes,
  );
  await capabilities.refresh(proxy, { apiKey: "fake-proxy-key" }, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(capabilities.resolve(proxy).status, "supported");
  assert.equal(capabilities.resolve({ ...proxy, id: "gpt-future" }).status, "unknown");
  assert.equal(
    capabilities.resolve(proxy, { baseUrl: "https://other.example/v1" }).status,
    "unsupported",
  );
});

test("payload gate keeps unrelated providers and APIs untouched even with a permissive capability callback", async () => {
  let reads = 0;
  const options = withFastPayload(
    undefined,
    async () => {
      reads++;
      return true;
    },
    {
      routes: new FastModeRoutes([route]),
      resolveCapability: () => ({ status: "supported", source: "model", reason: "test" }),
    },
  );
  for (const candidate of [
    { ...proxy, provider: "other" },
    { ...proxy, api: "openai-completions" },
    { ...proxy, baseUrl: "https://other.example/v1" },
  ]) {
    const payload = { model: candidate.id };
    assert.equal(await options.onPayload?.(payload, candidate), payload);
  }
  assert.equal(reads, 0);
  const payload = { model: proxy.id };
  assert.deepEqual(await options.onPayload?.(payload, proxy), {
    ...payload,
    service_tier: "priority",
  });
  assert.equal(reads, 1);
});

test("route configuration is optional, validated without leaking values, and snapshotted until reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-routes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fast-mode-proxies.json");
  assert.equal((await loadFastProxyRoutes(path)).includes(proxy), false);
  await writeFile(path, JSON.stringify({ version: 1, routes: [route] }));
  const first = await loadFastProxyRoutes(path);
  assert.equal(first.includes(proxy), true);
  await writeFile(path, JSON.stringify({ version: 1, routes: [] }));
  assert.equal((await loadFastProxyRoutes(path)).includes(proxy), false);
  assert.equal(first.includes(proxy), true, "existing session keeps its immutable scope");
  for (const raw of [
    "not json with secret",
    "null",
    JSON.stringify({ version: 2, routes: [route] }),
    JSON.stringify({ version: 1, routes: {} }),
    JSON.stringify({ version: 1, routes: [null] }),
    JSON.stringify({ version: 1, routes: [{ ...route, provider: "*" }] }),
    JSON.stringify({ version: 1, routes: [{ ...route, baseUrl: "file:///secret" }] }),
    JSON.stringify({
      version: 1,
      routes: [{ ...route, baseUrl: "https://user:secret@example.com" }],
    }),
    JSON.stringify({ version: 1, routes: [{ ...route, baseUrl: "https://example.com?secret" }] }),
    JSON.stringify({ version: 1, routes: Array(65).fill(route) }),
  ]) {
    await writeFile(path, raw);
    await assert.rejects(loadFastProxyRoutes(path), (error: Error) => {
      assert.match(error.message, /Invalid Fast-mode proxy configuration/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
});
