import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

process.stderr.write("fixture server chatter must not reach Pi\n");
if (process.argv.includes("--hang")) {
  process.stdin.resume();
} else {
  const noTools = process.argv.includes("--no-tools");
  const server = new Server(
    { name: "fixture", version: "1" },
    { capabilities: noTools ? {} : { tools: {} } },
  );
  if (!noTools) {
    server.setRequestHandler(ListToolsRequestSchema, async ({ params }) =>
      params?.cursor
        ? {
            tools: [{ name: "exit", inputSchema: { type: "object" } }],
          }
        : {
            tools: [
              { name: "echo", inputSchema: { type: "object" } },
              { name: "image", inputSchema: { type: "object" } },
            ],
            nextCursor: "page-2",
          },
    );
    let cancellations = 0;
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
      if (params.arguments?.delay) {
        const onAbort = () => {
          cancellations++;
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          await delay(1000, undefined, { signal });
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
      if (params.arguments?.reportCancellation)
        return { content: [{ type: "text", text: String(cancellations) }] };
      if (params.name === "exit")
        setTimeout(() => {
          void server.close();
        }, 15);
      if (params.name === "image")
        return {
          content: [
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            },
          ],
        };
      return { content: [{ type: "text", text: JSON.stringify(params.arguments ?? {}) }] };
    });
  }
  await server.connect(new StdioServerTransport());
}
