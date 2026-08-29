import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import webTools, {
  buildCrawlRequest,
  buildExtractRequest,
  buildMapRequest,
  buildSearchRequest,
  clipText,
  compactJson,
  createFirecrawlProvider,
  decodeCrawlCursor,
  encodeCrawlCursor,
  firecrawlRequest,
  pollCrawlStatus,
  resolveFirecrawlApiKey,
  shapeCrawlResponse,
  shapeExtractResponse,
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

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface TestTool {
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<TestToolResult>;
}

function registeredTools(): Map<string, unknown> {
  const tools = new Map<string, unknown>();
  const pi = {
    registerProvider() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  webTools(pi);
  return tools;
}

function testTool(tools: Map<string, unknown>, name: string): TestTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing test tool: ${name}`);
  return tool as TestTool;
}

function authenticatedContext(): ExtensionContext {
  return {
    modelRegistry: {
      async getProviderAuth() {
        return {
          auth: { apiKey: "fc-context-key" },
          source: "test credential",
        };
      },
    },
  } as unknown as ExtensionContext;
}

test("registers Firecrawl auth and the five flat web tools", () => {
  const providers: string[] = [];
  const tools: string[] = [];
  const executionModes: Array<string | undefined> = [];
  const pi = {
    registerProvider(provider: { id: string }) {
      providers.push(provider.id);
    },
    registerTool(tool: { name: string; executionMode?: string }) {
      tools.push(tool.name);
      executionModes.push(tool.executionMode);
    },
  } as unknown as ExtensionAPI;

  webTools(pi);

  assert.deepEqual(providers, ["firecrawl"]);
  assert.deepEqual(tools, ["search", "map", "fetch", "crawl", "extract"]);
  assert.deepEqual(executionModes, [
    "parallel",
    "parallel",
    "parallel",
    "sequential",
    "sequential",
  ]);
});

test("Firecrawl auth uses Pi's secret prompt and stored credential", async () => {
  const provider = createFirecrawlProvider();
  const auth = provider.auth.apiKey;
  if (!auth?.login) throw new Error("Firecrawl API-key login is missing");

  const credential = await auth.login({
    async prompt(prompt) {
      assert.equal(prompt.type, "secret");
      assert.equal(prompt.message, "Enter Firecrawl API key");
      return "fc-stored-key";
    },
    notify() {},
  });
  assert.deepEqual(credential, { type: "api_key", key: "fc-stored-key" });

  const resolved = await auth.resolve({
    credential,
    ctx: {
      async env() {
        return "fc-environment-key";
      },
      async fileExists() {
        return false;
      },
    },
  });
  assert.equal(resolved?.auth.apiKey, "fc-stored-key");
});

test("resolves Firecrawl credentials from Pi before the process environment", async () => {
  process.env.FIRECRAWL_API_KEY = "fc-environment-key";
  const key = await resolveFirecrawlApiKey(async (providerId) => {
    assert.equal(providerId, "firecrawl");
    return {
      auth: { apiKey: "fc-stored-key" },
      source: "stored credential",
    };
  });
  assert.equal(key, "fc-stored-key");
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

test("builds bounded crawl starts and validates opaque continuations", () => {
  const built = buildCrawlRequest({
    url: "https://docs.example.com/guide",
    include_paths: [" guides/.* ", "guides/.*"],
    exclude_paths: ["guides/archive/.*"],
  });

  assert.deepEqual(built, {
    cursorSkip: 0,
    pageSize: 2,
    maximumCharsPerPage: 12_000,
    request: {
      url: "https://docs.example.com/guide",
      limit: 10,
      maxDiscoveryDepth: 2,
      crawlEntireDomain: false,
      allowExternalLinks: false,
      allowSubdomains: false,
      ignoreQueryParameters: true,
      sitemap: "include",
      includePaths: ["guides/.*"],
      excludePaths: ["guides/archive/.*"],
      scrapeOptions: {
        formats: [{ type: "markdown" }],
        onlyMainContent: true,
      },
    },
  });

  const cursor = encodeCrawlCursor("crawl-123", 4);
  assert.equal(decodeCrawlCursor(cursor, "crawl-123"), 4);
  assert.deepEqual(
    buildCrawlRequest({ crawl_id: "crawl-123", cursor, page_size: 3 }),
    {
      crawlId: "crawl-123",
      cursorSkip: 4,
      pageSize: 3,
      maximumCharsPerPage: 12_000,
    },
  );
  assert.throws(() => decodeCrawlCursor(cursor, "different-job"), /belong/);
  assert.throws(
    () => buildCrawlRequest({ url: "https://example.com", crawl_id: "job" }),
    /exactly one/,
  );
  assert.throws(
    () => buildCrawlRequest({ crawl_id: "job", limit: 5 }),
    /valid only when starting/,
  );
});

test("builds safe single-page structured extraction requests", () => {
  const built = buildExtractRequest({
    url: "https://example.com/product",
    prompt: " Extract the name and price. ",
    schema_json: JSON.stringify({
      type: "object",
      properties: {
        price: { type: "string" },
        offer: {
          type: "object",
          properties: { currency: { type: "string" } },
          additionalProperties: false,
        },
        attributes: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      additionalProperties: false,
    }),
  });

  assert.deepEqual(built, {
    url: "https://example.com/product",
    maximumChars: 12_000,
    request: {
      url: "https://example.com/product",
      formats: [
        {
          type: "json",
          prompt: "Extract the name and price.",
          schema: {
            type: "object",
            properties: {
              price: { type: "string" },
              offer: {
                type: "object",
                properties: { currency: { type: "string" } },
              },
              attributes: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          },
          checkPromptInjection: true,
        },
      ],
      onlyMainContent: true,
    },
  });

  assert.deepEqual(
    buildExtractRequest({
      url: "https://example.com/product",
      prompt: "Extract the name.",
      check_prompt_injection: false,
    }),
    {
      url: "https://example.com/product",
      maximumChars: 12_000,
      request: {
        url: "https://example.com/product",
        formats: [{ type: "json", prompt: "Extract the name." }],
        onlyMainContent: true,
      },
    },
  );
  assert.throws(
    () =>
      buildExtractRequest({
        url: "https://example.com",
        prompt: "extract",
        schema_json: "[]",
      }),
    /JSON object/,
  );
  assert.throws(
    () =>
      buildExtractRequest({
        url: "https://example.com",
        prompt: "   ",
      }),
    /prompt must not be blank/,
  );
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

test("crawl and extraction shaping keep provenance and valid bounded data", () => {
  const crawl = shapeCrawlResponse(
    {
      status: "completed",
      total: 3,
      completed: 3,
      creditsUsed: 3,
      data: [
        {
          markdown: "a".repeat(1_000),
          metadata: {
            sourceURL: "https://example.com/a",
            title: "A",
            statusCode: 200,
          },
        },
        {
          markdown: "Page B",
          metadata: { sourceURL: "https://example.com/b" },
        },
        {
          markdown: "Page C",
          metadata: { sourceURL: "https://example.com/c" },
        },
      ],
    },
    "crawl-123",
    0,
    2,
    500,
  );
  assert.equal(crawl.pages.length, 2);
  assert.equal(crawl.pages[0]?.url, "https://example.com/a");
  assert.equal(crawl.pages[0]?.markdown.length, 500);
  assert.equal(crawl.completed, 3);
  assert.ok(crawl.next_cursor);
  assert.equal(decodeCrawlCursor(crawl.next_cursor, "crawl-123"), 2);

  const extraction = shapeExtractResponse(
    {
      data: {
        json: { description: "x".repeat(5_000), items: [1, 2, 3] },
        metadata: {
          sourceURL: "https://example.com/final",
          title: "Product",
        },
      },
    },
    "https://example.com/original",
    500,
  );
  assert.equal(extraction.url, "https://example.com/final");
  assert.equal(extraction.title, "Product");
  assert.equal(extraction.truncated, true);
  assert.doesNotThrow(() => JSON.parse(extraction.json));
  assert.ok(extraction.json.length <= 500);
  assert.equal(compactJson({ short: true }, 500).truncated, false);
});

test("crawl polling returns resumable state at its local deadline", async () => {
  let calls = 0;
  const result = await pollCrawlStatus(
    async () => {
      calls++;
      return { status: "scraping", completed: 0, total: 10, data: [] };
    },
    undefined,
    { timeoutMs: 5, intervalMs: 20, minimumDocuments: 2 },
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.payload.status, "scraping");
  assert.equal(calls, 1);
});

test("crawl starts once and reads later windows through its opaque cursor", async () => {
  const crawl = testTool(registeredTools(), "crawl");
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const request = {
      method: init?.method ?? "GET",
      url: String(input),
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    };
    requests.push(request);
    if (request.method === "POST")
      return new Response(JSON.stringify({ success: true, id: "crawl-123" }));
    const offset = request.url.includes("skip=2") ? 2 : 0;
    const documents = [
      {
        markdown: "Page A",
        metadata: { sourceURL: "https://example.com/a" },
      },
      {
        markdown: "Page B",
        metadata: { sourceURL: "https://example.com/b" },
      },
      {
        markdown: "Page C",
        metadata: { sourceURL: "https://example.com/c" },
      },
    ];
    return new Response(
      JSON.stringify({
        status: "completed",
        total: 3,
        completed: 3,
        creditsUsed: 3,
        data: documents.slice(offset),
      }),
    );
  };

  const first = await crawl.execute(
    "crawl-call-1",
    { url: "https://example.com/docs", page_size: 2 },
    undefined,
    undefined,
    authenticatedContext(),
  );
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[1]?.method, "GET");
  const startBody = requests[0]?.body;
  assert.ok(typeof startBody === "object" && startBody !== null);
  assert.equal(Reflect.get(startBody, "limit"), 10);
  assert.equal((first.details.pages as unknown[]).length, 2);
  const cursor = first.details.next_cursor;
  assert.equal(typeof cursor, "string");

  const second = await crawl.execute(
    "crawl-call-2",
    { crawl_id: "crawl-123", cursor },
    undefined,
    undefined,
    authenticatedContext(),
  );
  assert.match(requests[2]?.url ?? "", /skip=2/);
  assert.equal((second.details.pages as unknown[]).length, 1);
  assert.equal(second.details.next_cursor, undefined);
});

test("extract uses JSON-mode scrape with prompt-injection checking", async () => {
  const extract = testTool(registeredTools(), "extract");
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    if (typeof init?.body === "string")
      requestBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          json: { name: "Example", price: "$10" },
          metadata: {
            sourceURL: "https://example.com/product",
            title: "Product",
          },
        },
      }),
    );
  };

  const result = await extract.execute(
    "extract-call",
    {
      url: "https://example.com/product",
      prompt: "Extract name and price.",
    },
    undefined,
    undefined,
    authenticatedContext(),
  );
  const formats = requestBody?.formats as Array<Record<string, unknown>>;
  assert.equal(formats[0]?.type, "json");
  assert.equal(formats[0]?.checkPromptInjection, true);
  assert.deepEqual(result.details.data, { name: "Example", price: "$10" });
  assert.match(result.content[0]?.text ?? "", /"price": "\$10"/);
});

test("aborting a crawl best-effort cancels its remote job", async () => {
  const crawl = testTool(registeredTools(), "crawl");
  const controller = new AbortController();
  const methods: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method === "POST")
      return new Response(JSON.stringify({ success: true, id: "crawl-abort" }));
    if (method === "DELETE")
      return new Response(JSON.stringify({ success: true }));
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  };

  await assert.rejects(
    crawl.execute(
      "crawl-call",
      { url: "https://example.com" },
      controller.signal,
      undefined,
      authenticatedContext(),
    ),
    /cancelled/,
  );
  assert.deepEqual(methods, ["POST", "GET", "DELETE"]);
});

test("Firecrawl requests explain both credential setup paths", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  await assert.rejects(
    firecrawlRequest("/search", { query: "test" }),
    /Run \/login firecrawl.*FIRECRAWL_API_KEY/,
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

test("Firecrawl requests use bounded v2 paths and surface provider errors", async () => {
  process.env.FIRECRAWL_API_KEY = "fc-test-key";
  let requestUrl = "";
  let requestMethod = "";
  let authorization = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method ?? "GET";
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ success: true, data: { web: [] } }), {
      status: 200,
    });
  };

  await firecrawlRequest("/search", { query: "test" });
  assert.equal(requestUrl, "https://api.firecrawl.dev/v2/search");
  assert.equal(requestMethod, "POST");
  assert.equal(authorization, "Bearer fc-test-key");

  await firecrawlRequest(
    "/crawl/crawl-123?skip=2",
    undefined,
    undefined,
    undefined,
    "GET",
  );
  assert.equal(
    requestUrl,
    "https://api.firecrawl.dev/v2/crawl/crawl-123?skip=2",
  );
  assert.equal(requestMethod, "GET");
  await assert.rejects(
    firecrawlRequest("/../outside-v2", undefined),
    /Invalid Firecrawl API path/,
  );

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "bad request" }), {
      status: 400,
    });
  await assert.rejects(
    firecrawlRequest("/search", { query: "test" }),
    /Firecrawl request failed \(400\): bad request/,
  );
});
