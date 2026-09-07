import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { limitMcpOutput } from "../output.ts";
import { toMcpToolResult } from "../connect.ts";

test("ordinary MCP text is unchanged; images are native blocks rather than base64 text", async () => {
  assert.deepEqual(await limitMcpOutput("hello"), { text: "hello" });
  assert.deepEqual(
    toMcpToolResult({
      content: [
        { type: "text", text: "screenshot" },
        { type: "image", data: "pixel", mimeType: "image/png" },
      ],
    }),
    {
      text: "screenshot",
      isError: false,
      images: [{ type: "image", data: "pixel", mimeType: "image/png" }],
    },
  );
});

for (const text of [
  "x".repeat(DEFAULT_MAX_BYTES + 1000),
  "line\n".repeat(DEFAULT_MAX_LINES + 1000),
]) {
  test(`large MCP output is bounded and recoverable (${text.length} characters)`, async (t) => {
    const output = await limitMcpOutput(text);
    assert.ok(output.fullOutputPath);
    t.after(() => rm(dirname(output.fullOutputPath!), { recursive: true, force: true }));
    assert.match(output.text, /Output truncated/);
    assert.ok(Buffer.byteLength(output.text) <= DEFAULT_MAX_BYTES + 512);
    assert.ok(output.text.split("\n").length <= DEFAULT_MAX_LINES + 3);
    assert.equal(await readFile(output.fullOutputPath, "utf8"), text);
    assert.equal((await stat(output.fullOutputPath)).mode & 0o777, 0o600);
  });
}
