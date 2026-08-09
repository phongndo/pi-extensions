import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolSearchExtension, {
  onToolSearchReady,
  registerToolCapabilities,
} from "../index.ts";

function createHarness() {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const sessionHandlers = new Map<string, Array<() => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let active: string[] = [];
  const events = {
    emit(channel: string, data: unknown) {
      for (const handler of eventHandlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const handlers = eventHandlers.get(channel) ?? new Set();
      handlers.add(handler);
      eventHandlers.set(channel, handlers);
      return () => handlers.delete(handler);
    },
  };
  const pi = {
    events,
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
      active = [...new Set([...active, tool.name])];
    },
    registerCommand(name: string, command: unknown) {
      commands.set(name, command);
    },
    on(name: string, handler: () => unknown) {
      sessionHandlers.set(name, [
        ...(sessionHandlers.get(name) ?? []),
        handler,
      ]);
    },
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    tools,
    commands,
    active: () => [...active],
  };
}

test("registers capabilities and additively loads an exact match", async () => {
  const harness = createHarness();
  toolSearchExtension(harness.pi);
  for (const name of ["web_batch_fetch", "web_crawl"])
    harness.pi.registerTool({ name } as never);
  harness.pi.setActiveTools(["tool_search"]);

  const registration = registerToolCapabilities(harness.pi, {
    source: "web-tools",
    capabilities: [
      {
        id: "web.batch",
        description: "Fetch a larger set of known URLs.",
        aliases: ["batch", "batch fetch"],
        tags: ["urls", "concurrency"],
        tools: ["web_batch_fetch"],
      },
      {
        id: "web.crawl",
        description: "Discover linked pages recursively.",
        tools: ["web_crawl"],
      },
    ],
  });
  assert.equal(registration.accepted, true);

  const result = await harness.tools
    .get("tool_search")
    .execute("test", { query: "web.batch" });
  assert.deepEqual(
    result.details.matches.map((match: { id: string }) => match.id),
    ["web.batch"],
  );
  assert.deepEqual(result.details.added, ["web_batch_fetch"]);
  assert.deepEqual(harness.active(), ["tool_search", "web_batch_fetch"]);
});

test("searches descriptions and respects namespace and availability", async () => {
  const harness = createHarness();
  toolSearchExtension(harness.pi);
  for (const name of ["web_crawl", "review_run"])
    harness.pi.registerTool({ name } as never);
  harness.pi.setActiveTools(["tool_search"]);

  registerToolCapabilities(harness.pi, {
    source: "suite",
    capabilities: [
      {
        id: "web.crawl",
        description: "Discover linked documentation pages recursively.",
        tools: ["web_crawl"],
      },
      {
        id: "review.run",
        description: "Review source changes for regressions.",
        tools: ["review_run"],
      },
    ],
    resolveAvailable: () => ["web.crawl"],
  });

  const result = await harness.tools.get("tool_search").execute("test", {
    query: "documentation pages",
    namespace: "web",
  });
  assert.equal(result.details.matches[0]?.id, "web.crawl");
  assert.deepEqual(result.details.added, ["web_crawl"]);

  const unavailable = await harness.tools.get("tool_search").execute("test", {
    query: "regressions",
  });
  assert.deepEqual(unavailable.details.matches, []);
});

test("rejects conflicting capability owners without replacing the catalog", async () => {
  const harness = createHarness();
  toolSearchExtension(harness.pi);
  harness.pi.registerTool({ name: "one" } as never);
  harness.pi.registerTool({ name: "two" } as never);

  assert.equal(
    registerToolCapabilities(harness.pi, {
      source: "first",
      capabilities: [
        { id: "shared.lookup", description: "First", tools: ["one"] },
      ],
    }).accepted,
    true,
  );
  const conflict = registerToolCapabilities(harness.pi, {
    source: "second",
    capabilities: [
      { id: "shared.lookup", description: "Second", tools: ["two"] },
    ],
  });
  assert.equal(conflict.accepted, false);
  assert.match(conflict.errors[0] ?? "", /already registered by first/);
});

test("announces readiness for extensions loaded before tool search", () => {
  const harness = createHarness();
  let ready = 0;
  onToolSearchReady(harness.pi, () => ready++);
  toolSearchExtension(harness.pi);
  assert.equal(ready, 1);
});
