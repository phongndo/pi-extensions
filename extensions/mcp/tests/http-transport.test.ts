import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcpServer } from "../connect.ts";

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
