import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectMcpServer } from "../connect.ts";
import type { ResolvedMcpServer } from "../config.ts";

async function loadLocalExecutor(): Promise<ResolvedMcpServer | undefined> {
  const path = join(homedir(), ".config", "mcp", "mcp.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("mcpServers" in parsed)) return undefined;
  const servers = (parsed as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers;
  const executor = servers?.executor;
  if (!executor || typeof executor.url !== "string") return undefined;
  const headers =
    executor.headers && typeof executor.headers === "object"
      ? Object.fromEntries(
          Object.entries(executor.headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  const server: ResolvedMcpServer = {
    name: "executor",
    enabled: true,
    type: "http",
    source: path,
    url: executor.url,
  };
  if (headers && Object.keys(headers).length > 0) server.headers = headers;
  return server;
}

test("connects to the local executor MCP and runs execute", async (t) => {
  const server = await loadLocalExecutor();
  if (!server) {
    t.skip("shared executor MCP config is not present");
    return;
  }

  let session;
  try {
    session = await connectMcpServer(server);
  } catch (error) {
    t.skip(
      `executor MCP is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  try {
    const names = session.tools.map((tool) => tool.name);
    assert.ok(names.includes("execute"), `expected execute, got ${names.join(", ")}`);
    assert.ok(names.includes("resume"), `expected resume, got ${names.join(", ")}`);
    const result = await session.call("execute", { code: "return 1 + 1" }, undefined);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /\b2\b/);
  } finally {
    await session.close();
  }
});
