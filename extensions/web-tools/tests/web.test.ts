import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webTools, {
  buildMapRequest,
  buildSearchRequest,
  clipText,
  firecrawlRequest,
  shapeFetchResponse,
  shapeMapResponse,
  shapeSearchResponse,
  validatePublicUrl,
} from "../index.ts";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.FIRECRAWL_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = originalApiKey;
});

test("registers only the three flat web tools", () => {
  const names: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      names.push(tool.name);
    },
  } as unknown as ExtensionAPI;

  webTools(pi);

  assert.deepEqual(names, ["search", "map", "fetch"]);
});

test("builds a small deterministic search request", () => {
  assert.deepEqual(
    buildSearchRequest({
      query: "  release notes  ",
      sources: ["news", "web"],
      include_domains: ["Docs.Example.com/path", "https://docs.example.com"],
    }),
    {
      query: "release notes",
      limit: 5,
      sources: [{ type: "news" }, { type: "web" }],
      highlights: true,
      includeDomains: ["docs.example.com"],
    },
  );
  assert.throws(
    () => buildSearchRequest({ query: "   " }),
    /query must not be blank/,
  );
  assert.throws(
    () => buildSearchRequest({ query: "test", limit: 11 }),
    /between 1 and 10/,
  );
});

test("validates map inputs and public URLs", () => {
  assert.deepEqual(
    buildMapRequest({ url: "https://docs.example.com", search: " api " }),
    {
      url: "https://docs.example.com/",
      limit: 20,
      search: "api",
    },
  );
  assert.equal(
    validatePublicUrl("https://example.com/docs"),
    "https://example.com/docs",
  );
  assert.equal(
    validatePublicUrl("https://[2606:4700:4700::1111]"),
    "https://[2606:4700:4700::1111]/",
  );
  for (const value of [
    "file:///tmp/private",
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://192.168.1.2",
    "http://[::ffff:127.0.0.1]",
    "http://[::7f00:1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "https://user:pass@example.com",
  ]) {
    assert.throws(() => validatePublicUrl(value));
  }
});

test("search shaping prefers highlights and keeps source URLs", () => {
  const results = shapeSearchResponse({
    data: {
      web: [
        {
          title: "Primary source",
          url: "https://example.com/source",
          highlights: ["Most relevant", "Second passage"],
          snippet: "Fallback snippet",
        },
      ],
      news: [
        {
          title: "News",
          url: "https://news.example.com/story",
          description: "Description",
          date: "2026-03-01",
        },
      ],
    },
  });

  assert.deepEqual(results, [
    {
      source: "web",
      title: "Primary source",
      url: "https://example.com/source",
      excerpt: "Most relevant\nSecond passage",
    },
    {
      source: "news",
      title: "News",
      url: "https://news.example.com/story",
      date: "2026-03-01",
      excerpt: "Description",
    },
  ]);
});

test("map shaping accepts direct and nested Firecrawl responses", () => {
  assert.deepEqual(
    shapeMapResponse(
      {
        links: [
          "https://example.com/a",
          {
            url: "https://example.com/b",
            title: "B",
            description: "Page B",
          },
        ],
      },
      1,
    ),
    [{ url: "https://example.com/a" }],
  );
  assert.deepEqual(
    shapeMapResponse({ data: { links: [{ url: "https://example.com/c" }] } }),
    [{ url: "https://example.com/c" }],
  );
});

test("fetch shaping returns bounded Markdown and provenance", () => {
  const page = shapeFetchResponse(
    {
      data: {
        markdown: "a".repeat(100),
        metadata: {
          sourceURL: "https://example.com/final",
          title: "Example",
        },
      },
    },
    "https://example.com/original",
    50,
  );

  assert.equal(page.url, "https://example.com/final");
  assert.equal(page.title, "Example");
  assert.equal(page.markdown.length, 50);
  assert.match(page.markdown, /clipped/);
  assert.equal(clipText("short", 10), "short");
});

test("Firecrawl requests require the environment key", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  await assert.rejects(
    firecrawlRequest("/search", { query: "test" }),
    /FIRECRAWL_API_KEY is required/,
  );
});

test("classifies cancellation while reading a response body", async () => {
  process.env.FIRECRAWL_API_KEY = "fc-test-key";
  const controller = new AbortController();
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    }) as unknown as Response;

  await assert.rejects(
    firecrawlRequest(
      "/scrape",
      { url: "https://example.com" },
      controller.signal,
    ),
    /Web request was cancelled/,
  );
});

test("Firecrawl requests use the v2 endpoint and surface provider errors", async () => {
  process.env.FIRECRAWL_API_KEY = "fc-test-key";
  let requestUrl = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, data: { web: [] } }), {
      status: 200,
    });
  };

  await firecrawlRequest("/search", { query: "test" });
  assert.equal(requestUrl, "https://api.firecrawl.dev/v2/search");
  assert.equal(authorization, "Bearer fc-test-key");

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "bad request" }), {
      status: 400,
    });
  await assert.rejects(
    firecrawlRequest("/search", { query: "test" }),
    /Firecrawl request failed \(400\): bad request/,
  );
});
