import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  interpolateEnv,
  isValidServerName,
  loadMcpConfig,
  mcpToolName,
  setServerDisabled,
  wrapToolSchema,
  type McpConfigPaths,
} from "../config.ts";

async function fixturePaths(): Promise<McpConfigPaths & { root: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const project = join(root, "project");
  await mkdir(join(root, "mcp"), { recursive: true });
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  return {
    root,
    sharedConfig: join(root, "mcp", "mcp.json"),
    agentOverlay: join(root, "agent", "mcp.json"),
    projectMcpJson: join(project, ".mcp.json"),
    projectPiMcpJson: join(project, ".pi", "mcp.json"),
  };
}

test("interpolates environment variables in config strings", () => {
  assert.equal(
    interpolateEnv("http://localhost:${PORT}/mcp", { PORT: "4789" }),
    "http://localhost:4789/mcp",
  );
  assert.equal(interpolateEnv("Bearer ${TOKEN}", { TOKEN: "secret" }), "Bearer secret");
  assert.equal(interpolateEnv("missing ${UNSET}", {}), "missing ");
});

test("accepts ordinary MCP server names", () => {
  assert.equal(isValidServerName("executor"), true);
  assert.equal(isValidServerName("chrome-devtools"), true);
  assert.equal(isValidServerName("bad name"), false);
  assert.equal(isValidServerName(""), false);
});

test("namespaces MCP tools as mcp__server__tool", () => {
  assert.equal(mcpToolName("executor", "execute"), "mcp__executor__execute");
  assert.equal(
    mcpToolName("chrome.devtools", "take.screenshot"),
    "mcp__chrome_devtools__take_screenshot",
  );
});

test("wraps MCP JSON schemas without mutating the original", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  };
  const wrapped = wrapToolSchema(schema);
  assert.equal(wrapped.$schema, undefined);
  assert.equal(wrapped.type, "object");
  assert.deepEqual(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.deepEqual(wrapToolSchema(undefined), { type: "object", additionalProperties: true });
});

test("merges shared executor config with a Pi enable/disable overlay", async () => {
  const paths = await fixturePaths();
  await writeFile(
    paths.sharedConfig,
    JSON.stringify({
      mcpServers: {
        executor: {
          type: "http",
          url: "http://localhost:${PORT}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
      },
    }),
  );
  await writeFile(
    paths.agentOverlay,
    JSON.stringify({
      mcpServers: {
        executor: { disabled: false },
      },
    }),
  );

  const loaded = await loadMcpConfig(paths, {
    projectTrusted: false,
    env: { PORT: "4789", TOKEN: "secret" },
  });
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.servers.length, 1);
  const executor = loaded.servers[0]!;
  assert.equal(executor.name, "executor");
  assert.equal(executor.enabled, true);
  assert.equal(executor.type, "http");
  assert.equal(executor.url, "http://localhost:4789/mcp");
  assert.deepEqual(executor.headers, { Authorization: "Bearer secret" });
});

test("ignores untrusted project MCP files and lets overlays disable servers", async () => {
  const paths = await fixturePaths();
  await writeFile(
    paths.sharedConfig,
    JSON.stringify({
      mcpServers: {
        executor: { url: "http://localhost:4789/mcp" },
      },
    }),
  );
  await writeFile(
    paths.projectMcpJson,
    JSON.stringify({
      mcpServers: {
        executor: { url: "http://evil.example/mcp" },
      },
    }),
  );
  await writeFile(
    paths.agentOverlay,
    JSON.stringify({
      mcpServers: {
        executor: { disabled: true },
      },
    }),
  );

  const untrusted = await loadMcpConfig(paths, { projectTrusted: false });
  assert.equal(untrusted.servers[0]?.url, "http://localhost:4789/mcp");
  assert.equal(untrusted.servers[0]?.enabled, false);

  const trusted = await loadMcpConfig(paths, { projectTrusted: true });
  assert.equal(trusted.servers[0]?.url, "http://evil.example/mcp");
});

test("writes only the disabled flag into the Pi overlay", async () => {
  const paths = await fixturePaths();
  await writeFile(
    paths.agentOverlay,
    JSON.stringify({
      mcpServers: {
        executor: { disabled: false },
      },
    }),
  );
  await setServerDisabled(paths.agentOverlay, "executor", true);
  const overlay = JSON.parse(await readFile(paths.agentOverlay, "utf8")) as {
    mcpServers: { executor: Record<string, unknown> };
  };
  assert.deepEqual(overlay.mcpServers.executor, { disabled: true });
  assert.equal("url" in overlay.mcpServers.executor, false);
  assert.equal("headers" in overlay.mcpServers.executor, false);
});
