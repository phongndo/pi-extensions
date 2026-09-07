import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { connectMcpServer } from "../connect.ts";
import type { ResolvedMcpServer } from "../config.ts";

const fixture: ResolvedMcpServer = {
  name: "fixture",
  type: "stdio",
  enabled: true,
  source: "test",
  command: process.execPath,
  args: [fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url))],
};

test("actual MCP transport lists all pages, preserves images, and observes disconnects", async () => {
  const session = await connectMcpServer(fixture);
  try {
    assert.deepEqual(
      session.tools.map((tool) => tool.name),
      ["echo", "image", "exit"],
    );
    assert.equal((await session.call("echo", { value: 2 }, undefined)).text, '{"value":2}');
    const image = await session.call("image", {}, undefined);
    assert.equal(image.images?.[0]?.mimeType, "image/png");
    assert.doesNotMatch(image.text, /iVBOR/);
    const closed = new Promise<void>((resolve) => session.onClose!(resolve));
    await session.call("exit", {}, undefined);
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("disconnect not observed")), 2000);
        timer.unref();
        void closed.then(() => clearTimeout(timer));
      }),
    ]);
    let lateSubscriber = false;
    session.onClose!(() => {
      lateSubscriber = true;
    });
    assert.equal(lateSubscriber, true);
  } finally {
    await session.close();
  }
});

test("tool cancellation reaches the SDK server without dropping the connection", async () => {
  const session = await connectMcpServer(fixture);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(session.call("echo", { delay: true }, controller.signal));
    const result = await session.call("echo", { reportCancellation: true }, undefined);
    assert.equal(result.text, "1");
  } finally {
    clearTimeout(timer);
    await session.close();
  }
});

test("MCP servers without tools can still connect", async () => {
  const session = await connectMcpServer({ ...fixture, args: [...fixture.args!, "--no-tools"] });
  try {
    assert.deepEqual(session.tools, []);
  } finally {
    await session.close();
  }
});

test("shutdown aborts a hanging MCP handshake", async () => {
  const controller = new AbortController();
  const pending = connectMcpServer(
    { ...fixture, args: [...fixture.args!, "--hang"] },
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(pending);
  } finally {
    clearTimeout(timer);
  }
});

test("stdio server logs cannot corrupt the parent terminal or JSON output", async () => {
  const moduleUrl = new URL("../connect.ts", import.meta.url).href;
  const code = `import { connectMcpServer } from ${JSON.stringify(moduleUrl)};
const session = await connectMcpServer(${JSON.stringify(fixture)});
console.log(JSON.stringify(session.tools.map(tool => tool.name)));
await session.close();`;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", code],
    { timeout: 5000 },
  );
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), ["echo", "image", "exit"]);
});
