import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { toolResult } from "../output.ts";

test("web previews bound UTF-8 bytes and retain omitted provider fields privately", async () => {
  const payload = {
    data: { markdown: "文".repeat(30_000), omitted: "recover me" },
  };
  const result = await toolResult(payload.data.markdown, {}, payload, 2_000);
  const path = result.details.fullOutputPath;
  try {
    assert.ok(Buffer.byteLength(result.content[0]!.text) < 2_500);
    assert.match(result.content[0]!.text, /Preview truncated/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), payload);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    }
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("even short shaped previews retain full original fields", async () => {
  const result = await toolResult(
    "short preview",
    {},
    { markdown: "unabridged" },
  );
  try {
    assert.match(result.content[0]!.text, /Full provider response/);
    assert.doesNotMatch(result.content[0]!.text, /Preview truncated/);
    assert.equal(
      JSON.parse(await readFile(result.details.fullOutputPath, "utf8"))
        .markdown,
      "unabridged",
    );
  } finally {
    await rm(dirname(result.details.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }
});
