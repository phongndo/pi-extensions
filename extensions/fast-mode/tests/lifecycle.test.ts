import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  FooterComponent,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createFastModeExtension, type FastModeExtensionOptions } from "../index.ts";
import { FAST_MODE_STATUS_KEY } from "../footer.ts";
import { saveFastMode } from "../state.ts";
import { catalog, eventually, model, token } from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

async function harness(path: string, options: FastModeExtensionOptions = {}) {
  const handlers = new Map<string, Handler>();
  let command!: Command;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  let statusUpdates = 0;
  const registry = new ModelRegistry(runtime);
  const ctx = {
    mode: "rpc",
    hasUI: true,
    model: model(),
    modelRegistry: registry,
    sessionManager: SessionManager.inMemory(),
    ui: {
      setStatus: (key: string, value?: string) => {
        statusUpdates++;
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      notify: (message: string) => {
        notifications.push(message);
      },
      setFooter: () => {
        throw new Error("Must not replace the host/custom footer");
      },
    },
  } as unknown as ExtensionContext;
  const api = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    registerCommand: (_name: string, value: Command) => {
      command = value;
    },
  } as unknown as ExtensionAPI;
  createFastModeExtension({ statePath: path, discovery: false, pollMs: 25, ...options })(api);
  const emit = async (name: string) => {
    await handlers.get(name)?.({}, ctx);
  };
  return {
    ctx,
    registry,
    statuses,
    notifications,
    emit,
    command: async (args: string) => command.handler(args, ctx as ExtensionCommandContext),
    definition: command,
    get statusUpdates() {
      return statusUpdates;
    },
  };
}

test("commands publish on/off/unsupported/unknown/error status, are idempotent, and preserve footers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-lifecycle-"));
  const path = join(root, "fast-mode.json");
  const app = await harness(path);
  const original = FooterComponent.prototype.render;
  t.after(async () => {
    await app.emit("session_shutdown");
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(app.statuses.size, 0, "factory starts no UI or background resources");
  await app.emit("session_start");
  assert.deepEqual(app.notifications, [], "startup stays quiet");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast off");
  await app.command("status");
  assert.equal(app.notifications.at(-1), "Fast mode off");
  await assert.rejects(stat(path), { code: "ENOENT" });
  await app.command("on");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast on");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  const modified = (await stat(path)).mtimeMs;
  await app.command("on");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  await app.command("status");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  await app.command("details");
  assert.match(app.notifications.at(-1)!, /Support: supported \(fallback\)/);
  assert.match(app.notifications.at(-1)!, /Last request:/);
  assert.equal((await stat(path)).mtimeMs, modified);
  assert.deepEqual(app.definition.getArgumentCompletions?.("d"), [
    { value: "details", label: "details" },
  ]);
  app.ctx.model = model("gpt-future");
  await app.emit("model_select");
  assert.match(app.statuses.get(FAST_MODE_STATUS_KEY)!, /support unknown/);
  app.ctx.model = model("gpt-5.4-mini");
  await app.emit("model_select");
  assert.match(app.statuses.get(FAST_MODE_STATUS_KEY)!, /unavailable/);
  await app.command("bogus");
  assert.match(app.notifications.at(-1)!, /Usage:/);
  await app.command("off");
  assert.equal(app.notifications.at(-1), "Fast mode off");
  await app.command("off");
  assert.equal(app.notifications.at(-1), "Fast mode off");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast off");
  await app.command("");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  assert.match(app.statuses.get(FAST_MODE_STATUS_KEY)!, /fast on/);
  await app.command("");
  assert.equal(app.notifications.at(-1), "Fast mode off");
  await writeFile(path, "broken");
  await app.command("status");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast error");
  await app.command("on");
  assert.equal(await readFile(path, "utf8"), "broken");
  await saveFastMode(false, path);
  await eventually(() => app.statuses.get(FAST_MODE_STATUS_KEY) === "fast off");
  assert.equal(FooterComponent.prototype.render, original);
  await app.emit("session_shutdown");
  assert.equal(app.statuses.has(FAST_MODE_STATUS_KEY), false);
  await app.emit("session_start");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast off");
});

test("RPC gets status too; two sessions update without prompts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-rpc-"));
  const path = join(root, "fast-mode.json");
  const first = await harness(path);
  const second = await harness(path);
  Object.assign(second.ctx, { mode: "rpc" });
  t.after(async () => {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await rm(root, { recursive: true, force: true });
  });
  await first.emit("session_start");
  await second.emit("session_start");
  await first.command("on");
  await eventually(() => second.statuses.get(FAST_MODE_STATUS_KEY) === "fast on");
  await second.command("off");
  await eventually(() => first.statuses.get(FAST_MODE_STATUS_KEY) === "fast off");
});

test("explicit capability refresh changes UI support without changing saved state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-discover-ui-"));
  const path = join(root, "fast-mode.json");
  await saveFastMode(true, path);
  let calls = 0;
  const app = await harness(path, {
    discovery: true,
    fetchCatalog: async () => {
      calls++;
      return catalog([{ slug: "gpt-future", service_tiers: [{ id: "priority" }] }]);
    },
  });
  app.ctx.model = model("gpt-future");
  app.registry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token() });
  t.after(async () => {
    await app.emit("session_shutdown");
    await rm(root, { recursive: true, force: true });
  });
  await app.emit("session_start");
  assert.deepEqual(app.notifications, [], "enabled startup stays quiet too");
  await app.command("refresh");
  assert.equal(app.statuses.get(FAST_MODE_STATUS_KEY), "fast on");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  const count = calls;
  const before = (await stat(path)).mtimeMs;
  await app.command("status");
  assert.equal(app.notifications.at(-1), "Fast mode on");
  await app.command("details");
  assert.match(app.notifications.at(-1)!, /Support: supported \(catalog\)/);
  assert.equal(calls, count, "status and details do not fetch or refresh credentials");
  assert.equal((await stat(path)).mtimeMs, before);
});

test("real Pi loader puts the original glyph immediately before Astra, without a status row", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fast-host-footer-"));
  const path = join(root, "fast-mode.json");
  await saveFastMode(true, path);
  const fixture = join(root, "extension.ts");
  const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
  await writeFile(
    fixture,
    `import { createFastModeExtension } from ${JSON.stringify(extensionPath)};\nexport default createFastModeExtension({ statePath: ${JSON.stringify(path)}, discovery: false });\n`,
  );
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [fixture],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0]!;
  const app = await harness(path);
  Object.assign(app.ctx, { mode: "tui" });
  const invoke = async (name: "session_start" | "session_shutdown") => {
    for (const handler of extension.handlers.get(name) ?? [])
      await (handler as Handler)({ reason: "reload" }, app.ctx);
  };
  t.after(async () => {
    await invoke("session_shutdown");
    await rm(root, { recursive: true, force: true });
  });
  initTheme("dark", false);
  const original = FooterComponent.prototype.render;
  await invoke("session_start");
  const footerSession = {
    state: { model: model(), thinkingLevel: "xhigh" },
    sessionManager: app.ctx.sessionManager,
    getContextUsage: () => undefined,
    modelRuntime: { isUsingSubscription: () => true },
  } as unknown as ConstructorParameters<typeof FooterComponent>[0];
  const footerData = {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => app.statuses,
  } as unknown as ConstructorParameters<typeof FooterComponent>[1];
  const footer = new FooterComponent(footerSession, footerData);
  for (const theme of ["dark", "light"]) {
    initTheme(theme, false);
    for (const width of [16, 40, 60, 80, 120]) {
      const lines = footer.render(width);
      const modelLine = stripVTControlCharacters(lines[1]!);
      if (width >= 60) assert.match(modelLine, /ϟ gpt-6-astra/, `${theme}/${width}`);
      assert.equal(lines.length, 2, "Fast mode must not add a separate TUI status row");
      assert.ok(lines.every((line) => !line.includes("⚡") && visibleWidth(line) <= width));
    }
  }
  assert.equal(app.statuses.size, 0);
  app.statuses.set("other", "other extension status");
  const beforeUpdate = app.statusUpdates;
  await saveFastMode(false, path);
  await eventually(
    () => app.statusUpdates > beforeUpdate,
    "external toggles must request a TUI redraw",
  );
  assert.doesNotMatch(stripVTControlCharacters(footer.render(120)[1]!), /ϟ/);
  await saveFastMode(true, path);
  await eventually(() => footer.render(120)[1]!.includes("ϟ gpt-6-astra"));
  assert.equal(app.statuses.get("other"), "other extension status");
  assert.equal(app.statuses.has(FAST_MODE_STATUS_KEY), false);
  await invoke("session_shutdown");
  assert.equal(FooterComponent.prototype.render, original);
  await invoke("session_start");
  assert.match(stripVTControlCharacters(footer.render(120)[1]!), /ϟ gpt-6-astra/);
});
