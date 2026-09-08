import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createContextExtension } from "../index.ts";
import { recall } from "../model.ts";
import { assistant, checkpoint, model, temporary } from "./helpers.ts";

async function host(t: TestContext, respond: (context: Context) => AssistantMessage, auto = false) {
  const root = await temporary(t);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "offline-test-only");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: auto, keepRecentTokens: 90, reserveTokens: 16_384 },
    retry: { enabled: false },
    quietStartup: true,
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "Follow the user's task. Never deploy.",
    extensionFactories: [
      createContextExtension({ statePath: join(root, "context.json"), pollMs: 0 }),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sm = SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    sessionManager: sm,
    settingsManager,
    resourceLoader: loader,
    tools: ["recall", "notes"],
  });
  const errors: unknown[] = [];
  const compactionReasons: string[] = [];
  session.subscribe((event) => {
    if (event.type === "compaction_end" && event.result) compactionReasons.push(event.reason);
    if (event.type === "compaction_end" && event.errorMessage) t.diagnostic(event.errorMessage);
  });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  session.agent.streamFunction = (_model, context) => {
    const result = respond(context);
    // An instantaneous fake provider can share the compaction's millisecond. Pi
    // deliberately ignores usage at/before that boundary as stale. Model the
    // causal ordering of a real response without sleeps or a timing-dependent test.
    const boundary = sm
      .getBranch()
      .filter((entry) => entry.type === "compaction")
      .at(-1);
    if (boundary) result.timestamp = Math.max(result.timestamp, Date.parse(boundary.timestamp) + 1);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: result });
    if (result.stopReason === "error" || result.stopReason === "aborted")
      stream.push({ type: "error", reason: result.stopReason, error: result });
    else
      stream.push({
        type: "done",
        reason: result.stopReason as "stop" | "toolUse" | "length",
        message: result,
      });
    stream.end(result);
    return stream;
  };
  t.after(async () => {
    await session.abort();
    session.dispose();
  });
  return { session, sm, errors, compactionReasons };
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Host did not settle/continue within 3 seconds");
}

for (const automatic of [false, true]) {
  test(
    `real Pi lifecycle: ${automatic ? "threshold" : "requested"} resets twice and continues without summarization or unmatched tools`,
    { timeout: 10_000 },
    async (t) => {
      let calls = 0;
      const payloads: Context[] = [];
      const app = await host(
        t,
        (context) => {
          payloads.push({ ...context, messages: structuredClone(context.messages) });
          calls++;
          if (calls <= 2)
            return assistant(
              [
                {
                  type: "toolCall",
                  id: `checkpoint-${calls}`,
                  name: "notes",
                  arguments: { action: "checkpoint", checkpoint, reset: true },
                },
              ],
              automatic ? 115_000 : 100,
            );
          return assistant([{ type: "text", text: "Completed after two fresh windows." }]);
        },
        automatic,
      );
      await app.session.prompt("ORIGINAL USER PAYLOAD. Fix the bug and report, without deploying.");
      try {
        await eventually(() => calls >= 3 && app.session.isIdle);
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            calls,
            idle: app.session.isIdle,
            errors: app.errors,
            entries: app.sm.getBranch(),
          }),
        );
        throw error;
      }
      assert.deepEqual(app.errors, []);
      assert.equal(calls, 3, "No generated summary calls or unexpected continuations");
      assert.deepEqual(
        app.compactionReasons,
        automatic ? ["threshold", "threshold"] : ["manual", "manual"],
      );
      assert.equal(
        app.sm.getBranch().filter((entry) => entry.type === "compaction").length,
        2,
        JSON.stringify(app.sm.getBranch()),
      );
      for (const context of payloads.slice(1)) {
        const text = JSON.stringify(context.messages);
        assert.match(text, /First fix failed/);
        assert.doesNotMatch(text, /ORIGINAL USER PAYLOAD|"toolResult"|"toolCall"/);
      }
      const firstUser = app.sm
        .getBranch()
        .find((entry) => entry.type === "message" && entry.message.role === "user")!;
      assert.match(
        JSON.stringify(recall(app.sm.getBranch(), { entryId: firstUser.id })),
        /ORIGINAL USER PAYLOAD/,
      );
    },
  );
}

test(
  "real Pi overflow with no checkpoint falls back to stock compaction and retries",
  { timeout: 10_000 },
  async (t) => {
    let calls = 0;
    let summaries = 0;
    const app = await host(
      t,
      (context) => {
        if (context.systemPrompt?.includes("summarization")) {
          summaries++;
          return assistant([
            { type: "text", text: "Stock fallback summary: continue the user's fix." },
          ]);
        }
        calls++;
        if (calls === 1)
          return {
            ...assistant([]),
            stopReason: "error",
            errorMessage: "maximum context length exceeded",
          };
        return assistant([{ type: "text", text: "Recovered normally." }]);
      },
      true,
    );
    // Give pi a compactable prior turn before triggering the synthetic overflow.
    app.sm.appendMessage({
      role: "user",
      content: "Previous investigation",
      timestamp: Date.now(),
    });
    app.sm.appendMessage(
      assistant([{ type: "text", text: "Previous findings " + "x".repeat(1000) }]),
    );
    app.session.agent.state.messages = app.sm.buildSessionContext().messages;
    await app.session.prompt("Continue the fix");
    await eventually(() => app.session.isIdle);
    assert.deepEqual(app.errors, []);
    assert.ok(summaries > 0);
    assert.equal(calls, 2);
    const entry = app.sm.getBranch().find((item) => item.type === "compaction");
    assert.ok(entry?.type === "compaction");
    assert.notEqual(entry.fromHook, true);
  },
);

test(
  "real Pi handles late steering without dropping it or starting a redundant continuation",
  { timeout: 10_000 },
  async (t) => {
    const payloads: Context[] = [];
    let calls = 0;
    const app = await host(t, (context) => {
      payloads.push({ ...context, messages: structuredClone(context.messages) });
      if (++calls === 1)
        return assistant([
          {
            type: "toolCall",
            id: "checkpoint",
            name: "notes",
            arguments: { action: "checkpoint", checkpoint, reset: true },
          },
        ]);
      return assistant([{ type: "text", text: "Handled the latest steering." }]);
    });
    app.session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "notes")
        void app.session.steer("LATEST STEERING: leave the database unchanged.");
    });
    await app.session.prompt("ORIGINAL TASK: fix the bug without deploying.");
    await eventually(() => calls >= 2 && app.session.isIdle);
    assert.deepEqual(app.errors, []);
    assert.equal(calls, 2);
    assert.equal(app.sm.getBranch().filter((entry) => entry.type === "compaction").length, 0);
    assert.match(JSON.stringify(payloads[1]!.messages), /LATEST STEERING/);
    assert.match(JSON.stringify(payloads[1]!.messages), /ORIGINAL TASK/);
  },
);

test("real Pi resource loader imports the registered extension from disk", async (t) => {
  const root = await temporary(t);
  const entry = join(root, "fixture.ts");
  await writeFile(
    entry,
    `import { createContextExtension } from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))}; export default createContextExtension({statePath:${JSON.stringify(join(root, "context.json"))},pollMs:0});`,
  );
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    settingsManager: SettingsManager.inMemory({}),
    additionalExtensionPaths: [entry],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.ok(loaded.extensions[0]!.commands.has("context"));
  assert.ok(loaded.extensions[0]!.tools.has("recall"));
  assert.ok(loaded.extensions[0]!.tools.has("notes"));
});
