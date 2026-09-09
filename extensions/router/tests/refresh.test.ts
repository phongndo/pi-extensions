import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createRouterExtension } from "../index.ts";
import { loginId, poolId } from "../../../src/account-identity.ts";

const oauth = (access: string) => ({
  type: "oauth" as const,
  access,
  refresh: access,
  expires: Date.now() + 3600000,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function harness() {
  const directory = mkdtempSync(join(tmpdir(), "router-refresh-"));
  const path = join(directory, "router.json");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => oauth("one"));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => any>();
  const notices: string[] = [];
  const events = createEventBus();
  const ctx = {
    model: runtime.getProvider("openai-codex")!.getModels()[0],
    modelRegistry: new ModelRegistry(runtime),
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => any) =>
      hooks.set(name, handler),
    registerCommand: () => {},
    registerProvider: (provider: Provider) => runtime.registerNativeProvider(provider),
    unregisterProvider: (id: string) => runtime.unregisterProvider(id),
    setModel: async (model: ExtensionContext["model"]) => {
      Object.assign(ctx, { model });
      return true;
    },
  } as unknown as ExtensionAPI;
  await createRouterExtension({
    configPath: path,
    legacyPath: join(directory, "absent"),
    credentials,
    modelsPath: null,
    pollMs: 60000,
  })(pi);
  const invoke = (name: string) => hooks.get(name)!({} as never, ctx);
  await invoke("session_start");
  return {
    credentials,
    runtime,
    path,
    ctx,
    events,
    notices,
    invoke,
    close: async () => {
      await invoke("session_shutdown");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("input following a login does not reuse a pre-login in-flight metadata snapshot", async () => {
  const h = await harness();
  const captured = deferred(),
    release = deferred();
  const list = h.credentials.list.bind(h.credentials);
  let pause = true;
  h.credentials.list = async (options) => {
    const snapshot = await list(options);
    if (pause) {
      pause = false;
      captured.resolve();
      await release.promise;
    }
    return snapshot;
  };
  try {
    h.events.emit("router:request-accounts", {});
    await captured.promise;
    await h.credentials.modify(loginId("openai-codex", 2), async () => oauth("two"));
    const input = h.invoke("input");
    release.resolve();
    await input;
    expect(h.ctx.model?.provider).toBe(poolId("openai-codex"));
  } finally {
    release.resolve();
    await h.close();
  }
});

test("bad rankings do not throw into every input/model event; warn once and recover", async () => {
  const h = await harness();
  try {
    writeFileSync(h.path, "{broken SECRET");
    for (let n = 0; n < 3; n++) {
      expect(await h.invoke("input")).toEqual({ action: "continue" });
      await h.invoke("model_select");
    }
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain("router.json");
    expect(h.notices[0]).not.toContain("SECRET");
    await h.credentials.modify(loginId("openai-codex", 2), async () => oauth("two"));
    writeFileSync(h.path, JSON.stringify({ version: 1, order: {} }));
    await h.invoke("input");
    expect(h.ctx.model?.provider).toBe(poolId("openai-codex"));
    writeFileSync(h.path, "{broken again");
    await h.invoke("input");
    expect(h.notices).toHaveLength(2);
    expect(h.ctx.model?.provider).toBe(poolId("openai-codex"));
    const result = await h.runtime
      .getProvider(poolId("openai-codex"))!
      .streamSimple(h.ctx.model!, { messages: [] })
      .result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain(h.path);
  } finally {
    await h.close();
  }
});
