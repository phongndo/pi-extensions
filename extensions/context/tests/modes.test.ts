import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadMode, saveMode, type ContextMode } from "../state.ts";
import { diagnostics } from "../diagnostics.ts";
import { harness, temporary, user } from "./helpers.ts";

test("two modes migrate old preferences without rewriting files or reviving memory-only mode", async (t) => {
  const path = join(await temporary(t), "context.json");
  assert.equal(await loadMode(path), "default");
  for (const [data, expected] of [
    [{ version: 1, enabled: false }, "default"],
    [{ version: 1, enabled: true }, "exp"],
    [{ version: 2, mode: "exp-1" }, "default"],
    [{ version: 2, mode: "exp-2" }, "exp"],
    [{ version: 2, mode: "default" }, "default"],
  ] as const) {
    const original = JSON.stringify(data);
    await writeFile(path, original);
    assert.equal(await loadMode(path), expected);
    assert.equal(await readFile(path, "utf8"), original);
  }
  for (const mode of ["default", "exp"] as const) {
    await saveMode(path, mode);
    assert.equal(await loadMode(path), mode);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 3, mode });
  }
  const before = await readFile(path, "utf8");
  await assert.rejects(saveMode(path, "exp-1" as ContextMode));
  assert.equal(await readFile(path, "utf8"), before);
});

test("default hides memory schemas, guidance, markers and reminders without erasing history", async (t) => {
  const app = await harness(t, { initialMode: null });
  assert.equal(app.statuses.get("context"), "ctxt default");
  assert.deepEqual(app.controls.tools, ["read", "bash"]);
  assert.equal(diagnostics(app.sm.getBranch())[0]!.mode, "default");
  const id = user(app.sm, "Original requirement");
  const before = JSON.stringify(app.sm.getEntries());
  app.controls.tokens = 120_000;
  assert.equal(await app.emit("before_agent_start", { systemPrompt: "base" }), undefined);
  assert.equal(
    await app.emit("context", { messages: app.sm.buildSessionContext().messages }),
    undefined,
  );
  assert.equal(await app.beforeCompact(), undefined);
  await assert.rejects(app.execute("recall", { entryId: id }), /disabled in default/);
  await assert.rejects(
    app.execute("notes", { action: "write", name: "x", text: "x" }),
    /disabled in default/,
  );
  assert.equal(JSON.stringify(app.sm.getEntries()), before);
  await assert.rejects(readFile(app.path), { code: "ENOENT" });
});

test("mode switches retain notes and restore only memory tools hidden by this extension", async (t) => {
  const app = await harness(t, { initialMode: "default" });
  const id = user(app.sm);
  await app.command("exp");
  assert.deepEqual(
    new Set(app.controls.tools),
    new Set(["read", "bash", "recall", "notes", "new_context"]),
  );
  const note = await app.execute("notes", {
    action: "write",
    name: "decision",
    text: "Verified: preserve source",
    references: [id],
  });
  const noteId = (note.details as { entryId: string }).entryId;
  await app.command("default");
  app.controls.tools.push("other-extension-tool");
  await app.command("exp");
  assert.ok(app.controls.tools.includes("other-extension-tool"));
  assert.match(JSON.stringify(await app.execute("recall", { entryId: noteId })), /preserve source/);
  assert.equal(await loadMode(app.path), "exp");
  app.controls.tools = ["read", "recall"];
  await app.command("default");
  await app.command("exp");
  assert.deepEqual(new Set(app.controls.tools), new Set(["read", "recall"]));
  assert.equal(await app.emit("before_agent_start", { systemPrompt: "base" }), undefined);
});

test("shutdown releases suppression even when the old runtime is aborting", async (t) => {
  const app = await harness(t, { initialMode: "default" });
  app.controls.idle = false;
  await app.emit("session_shutdown");
  app.controls.idle = true;
  await saveMode(app.path, "exp");
  await app.emit("session_start");
  assert.ok(app.controls.tools.includes("recall"));
  assert.ok(app.controls.tools.includes("notes"));
});

test("only exp permits a verified fresh window; removed commands are rejected", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  await app.command("default");
  const leaf = app.sm.getLeafId();
  assert.equal(await app.beforeCompact(), undefined);
  assert.equal(app.sm.getLeafId(), leaf);
  for (const obsolete of ["exp-1", "exp-2"]) {
    await app.command(obsolete);
    assert.match(app.notifications.at(-1)!, /Usage:/);
    assert.equal(await loadMode(app.path), "default");
  }
  await app.command("exp");
  assert.ok((await app.beforeCompact())?.compaction);
});

test("mid-turn switches block stale memory calls and defer schema changes until idle", async (t) => {
  const app = await harness(t);
  user(app.sm);
  await app.newContext();
  app.controls.idle = false;
  await app.command("default");
  assert.ok(app.controls.tools.includes("notes"));
  await assert.rejects(app.execute("recall", {}), /disabled in default/);
  app.controls.idle = true;
  await app.emit("agent_settled");
  assert.ok(!app.controls.tools.includes("notes"));
  assert.equal(app.compactions.length, 0);
  assert.equal(app.sent.length, 0, "mode changes stop rather than silently resume old history");
});

test("external mode changes synchronize when idle; corrupt preferences fail closed", async (t) => {
  const app = await harness(t, { pollMs: 10 });
  await saveMode(app.path, "default");
  for (let i = 0; i < 100 && app.controls.tools.includes("recall"); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!app.controls.tools.includes("recall"));
  await writeFile(app.path, '{"version":3,"mode":"unknown"}');
  await app.command("status");
  assert.equal(app.statuses.get("context"), "ctxt default !");
  await app.command("exp");
  assert.ok(app.controls.tools.includes("recall"));
  assert.equal(app.statuses.get("context"), "ctxt exp");
  assert.deepEqual(app.commands.get("context")!.getArgumentCompletions!("exp"), [
    { value: "exp", label: "exp" },
  ]);
});
