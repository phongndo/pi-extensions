import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpServer, isTransientMcpError } from "../connect.ts";

test("SSE initialization POST retains its transient HTTP status", async (t) => {
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: endpoint\ndata: /messages\n\n");
    } else {
      res.writeHead(503).end("unavailable");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(
    connectMcpServer({
      name: "local",
      type: "sse",
      enabled: true,
      source: "test",
      url: `http://127.0.0.1:${address.port}/sse`,
    }),
    (error: unknown) => isTransientMcpError(error),
  );
});

test("expired HTTP session closes client for reconnection without replaying a tool call", async (t) => {
  let sessionNumber = 0;
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.method === "GET") return void res.writeHead(405).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
      };
      if (message.method === "notifications/initialized") return void res.writeHead(202).end();
      if (message.method === "initialize") {
        sessionNumber++;
        res.setHeader("mcp-session-id", `session-${sessionNumber}`);
        return void res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "local", version: "1" },
            },
          }),
        );
      }
      if (message.method === "tools/call") {
        calls++;
        if (req.headers["mcp-session-id"] === "session-1") return void res.writeHead(404).end();
      }
      const result =
        message.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "ok" }] };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const config = {
    name: "local",
    type: "http" as const,
    enabled: true,
    source: "test",
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
  const first = await connectMcpServer(config);
  t.after(() => first.close());
  let closed = 0;
  let reason: string | undefined;
  first.onClose!((why) => {
    closed++;
    reason = why;
  });
  await assert.rejects(first.call("echo", {}, undefined), /session expired; reconnecting/);
  assert.equal(closed, 1);
  assert.equal(reason, "HTTP session expired");
  assert.equal(calls, 1, "ambiguous tool calls must never be replayed");
  const second = await connectMcpServer(config);
  t.after(() => second.close());
  assert.equal((await second.call("echo", {}, undefined)).text, "ok");
  assert.equal(calls, 2);
});

test(
  "an interrupted HTTP tool response fails promptly and disconnects",
  { timeout: 3000 },
  async (t) => {
    let calls = 0;
    const server = createServer((req, res) => {
      if (req.method === "GET") return void res.writeHead(405).end();
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const message = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: number;
          method: string;
        };
        if (message.method === "notifications/initialized") return void res.writeHead(202).end();
        if (message.method === "tools/call") {
          calls++;
          res.writeHead(200, { "content-type": "text/event-stream" });
          if (calls <= 2) {
            const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`;
            if (calls === 2) setTimeout(() => res.end(frame), 250);
            else res.end(frame);
            return;
          }
          return void res.end("event: message\n");
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "local", version: "1" },
              }
            : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = await connectMcpServer({
      name: "local",
      type: "http",
      enabled: true,
      source: "test",
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    t.after(() => client.close());
    let reason: string | undefined;
    client.onClose!((why) => {
      reason = why;
    });
    assert.equal((await client.call("echo", {}, undefined)).text, "ok");
    assert.equal((await client.call("echo", {}, undefined)).text, "ok");
    assert.equal(reason, undefined, "an earlier completed stream must not close a later call");
    await assert.rejects(
      Promise.race([
        client.call("echo", {}, undefined),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("tool call hung")), 700),
        ),
      ]),
      (error: unknown) => error instanceof Error && error.message !== "tool call hung",
    );
    assert.equal(reason, "HTTP tool response interrupted");
    assert.equal(calls, 3, "the interrupted call must not be replayed");
  },
);

test("network failure during a tool call closes the stale client without replay", async (t) => {
  const sdk = new Server({ name: "local", version: "1" }, { capabilities: { tools: {} } });
  sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await sdk.connect(transport as Transport);
  let calls = 0;
  sdk.setRequestHandler(CallToolRequestSchema, async () => {
    calls++;
    return { content: [{ type: "text", text: "ok" }] };
  });
  const server = createServer((req, res) => {
    if (req.method === "GET") return void res.writeHead(405).end();
    void transport.handleRequest(req, res).catch(() => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await sdk.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = await connectMcpServer({
    name: "local",
    type: "http",
    enabled: true,
    source: "test",
    url: `http://127.0.0.1:${address.port}/mcp`,
  });
  t.after(() => client.close());
  let reason: string | undefined;
  client.onClose!((why) => {
    reason = why;
  });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assert.rejects(client.call("echo", {}, undefined));
  assert.equal(reason, "HTTP transport unavailable");
  assert.equal(calls, 0, "failed tool calls must not be replayed");
});

test(
  "exhausted HTTP notification stream retries close the stale client",
  { timeout: 6500 },
  async (t) => {
    const sdk = new Server({ name: "local", version: "1" }, { capabilities: { tools: {} } });
    sdk.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await sdk.connect(transport as Transport);
    let gets = 0;
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        gets++;
        if (gets > 1) return void res.writeHead(503).end();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": idle stream\n\n");
        setTimeout(() => res.end(), 25);
        return;
      }
      void transport.handleRequest(req, res).catch(() => res.end());
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await sdk.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = await connectMcpServer({
      name: "local",
      type: "http",
      enabled: true,
      source: "test",
      url: `http://127.0.0.1:${address.port}/mcp`,
    });
    t.after(() => client.close());
    let closed = false;
    let reason: string | undefined;
    client.onClose!((why) => {
      closed = true;
      reason = why;
    });
    for (let i = 0; i < 90 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(gets >= 3);
    assert.equal(closed, true, "lost notification streams must not remain connected forever");
    assert.equal(reason, "HTTP notification stream lost");
  },
);

for (const type of ["http", "sse"] as const) {
  test(
    `local ${type}: schema preservation, headers, transient errors and explicit close`,
    { timeout: 10_000 },
    async (t) => {
      const schema = {
        type: "object" as const,
        properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
        required: ["value"],
        additionalProperties: false,
      };
      const sdk = new Server({ name: "local", version: "1" }, { capabilities: { tools: {} } });
      sdk.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "echo", inputSchema: schema }],
      }));
      sdk.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
        content: [{ type: "text", text: JSON.stringify(params.arguments) }],
      }));
      let transport: SSEServerTransport | StreamableHTTPServerTransport;
      let failNext = false;
      const headers: Array<string | undefined> = [];
      const server = createServer((req, res) => {
        headers.push(req.headers.authorization);
        if (failNext && req.method === "POST") {
          failNext = false;
          res.writeHead(503).end("temporary fixture failure");
          return;
        }
        const handle = async () => {
          if (type === "sse") {
            if (req.method === "GET") {
              transport = new SSEServerTransport("/messages", res);
              await sdk.connect(transport);
            } else {
              await (transport as SSEServerTransport).handlePostMessage(req, res);
            }
          } else {
            await (transport as StreamableHTTPServerTransport).handleRequest(req, res);
          }
        };
        void handle().catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      t.after(async () => {
        await sdk.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      if (type === "http") {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        // SDK optional callback declarations differ under exactOptionalPropertyTypes.
        await sdk.connect(transport as Transport);
      }
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const client = await connectMcpServer({
        name: "local",
        type,
        enabled: true,
        source: "test",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: { Authorization: "Bearer fixture-only" },
      });
      t.after(() => client.close());
      let closed = 0;
      client.onClose!(() => {
        closed++;
      });
      assert.deepEqual(JSON.parse(JSON.stringify(client.tools[0]!.inputSchema)), schema);
      assert.equal((await client.call("echo", { value: 42 }, undefined)).text, '{"value":42}');
      failNext = true;
      await assert.rejects(client.call("echo", { value: "fails" }, undefined));
      assert.equal(closed, 0, "a request error must not evict a usable connection");
      assert.equal(
        (await client.call("echo", { value: "recovered" }, undefined)).text,
        '{"value":"recovered"}',
      );
      assert.ok(headers.length >= 5);
      assert.ok(headers.every((header) => header === "Bearer fixture-only"));
      await client.close();
      await client.close();
      assert.equal(closed, 1);
    },
  );
}
