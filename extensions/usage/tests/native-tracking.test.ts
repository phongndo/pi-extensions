import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createUsageExtension } from "../index.ts";
import { UsageLedger } from "../ledger.ts";

test("native subscription responses are recorded even before Pi's availability snapshot has refreshed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-native-usage-"));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "fake-access",
    refresh: "fake-refresh",
    expires: Date.now() + 3600000,
  }));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const model = runtime.getProvider("openai-codex")!.getModels()[0]!;
  // Authentication actually resolves as OAuth, but this synchronous compatibility flag is stale.
  expect((await runtime.getAuth(model))?.auth.apiKey).toBe("fake-access");
  expect(registry.isUsingOAuth(model)).toBe(false);
  const hooks = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  const pi = {
    events: createEventBus(),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      hooks.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "session" },
    ui: { notify: () => {} },
  } as unknown as ExtensionContext;
  try {
    createUsageExtension({ directory, credentials, modelsPath: null, live: false })(pi);
    await hooks.get("session_start")!({} as never, ctx);
    await hooks.get("message_end")!(
      {
        message: {
          role: "assistant",
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "toolUse",
          content: [],
          usage: {
            input: 10,
            output: 3,
            cacheRead: 20,
            cacheWrite: 0,
            totalTokens: 33,
            cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          },
        },
      } as never,
      ctx,
    );
    const { records } = await new UsageLedger(directory).read();
    expect(records).toHaveLength(1);
    expect(records[0]?.subscription).toBe(true);
    expect(records[0]?.usage.totalTokens).toBe(33);
    expect((await credentials.read("openai-codex"))?.type).toBe("oauth");
    await runtime.refresh({ allowNetwork: false });
    expect(registry.isUsingOAuth(model)).toBe(true);
    await credentials.modify("openai-codex", async () => ({
      type: "api_key",
      key: "excluded-api-key",
    }));
    // The inverse stale-cache case must not leak API usage into subscription history.
    await hooks.get("message_end")!(
      {
        message: {
          role: "assistant",
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: "stop",
          content: [],
          usage: records[0]!.usage,
        },
      } as never,
      ctx,
    );
    expect((await new UsageLedger(directory).read()).records).toHaveLength(1);
  } finally {
    await hooks.get("session_shutdown")?.({} as never, ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
