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
import contextExtension from "../index.ts";
import { recall } from "../model.ts";
import { diagnostics } from "../diagnostics.ts";
import { assistant, model, temporary, user } from "./helpers.ts";

async function host(
  t: TestContext,
  visibility: "available" | "excluded",
  respond: (context: Context) => AssistantMessage = () =>
    assistant([{ type: "text", text: "Investigated. ".repeat(200) }]),
  options: { auto?: boolean; existing?: SessionManager; standardPrompt?: boolean } = {},
) {
  const root = await temporary(t);
  const path = join(root, "context.json");
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "offline-test-only");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: options.auto ?? false, keepRecentTokens: 64, reserveTokens: 16_384 },
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
    ...(options.standardPrompt
      ? {}
      : { systemPromptOverride: () => "Follow the user's task. Never deploy." }),
    extensionFactories: [
      (pi) => {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: event.systemPrompt + "\nEarlier extension instruction.",
        }));
      },
      contextExtension,
      (pi) => {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: event.systemPrompt + "\nLater extension instruction.",
        }));
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sm = options.existing ?? SessionManager.create(root, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime,
    model,
    sessionManager: sm,
    settingsManager,
    resourceLoader: loader,
    tools: ["recall"],
    ...(visibility === "excluded" ? { excludeTools: ["recall"] } : {}),
  });
  const errors: unknown[] = [];
  const compactionReasons: string[] = [];
  const payloads: Context[] = [];
  const summaries: Context[] = [];
  session.subscribe((event) => {
    if (event.type === "compaction_end" && event.result) compactionReasons.push(event.reason);
  });
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  // Both normal turns and Pi's real summarizer use this offline transport.
  // Network catalogs, user auth, resources and tools are never loaded.
  session.agent.streamFunction = (_model, context, options) => {
    const summary = context.systemPrompt?.includes("summarization");
    (summary ? summaries : payloads).push({
      ...context,
      messages: structuredClone(context.messages),
    });
    const result = options?.signal?.aborted
      ? { ...assistant([]), stopReason: "aborted" as const, errorMessage: "Request aborted" }
      : summary
        ? assistant([
            {
              type: "text",
              text: "Stock Pi summary: investigate without deployment; preserve original requirements.",
            },
          ])
        : respond(context);
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
  return { session, sm, path, errors, compactionReasons, payloads, summaries };
}

function stage(sm: SessionManager) {
  const original = user(sm, "ORIGINAL USER PAYLOAD: do not deploy; investigate retry.");
  sm.appendMessage(assistant([{ type: "toolCall", id: "test", name: "test_log", arguments: {} }]));
  const text =
    "FAIL retry_outer expected=3 actual=4\n" + "界🙂e\u0301\r\n".repeat(5000) + "END ORIGINAL";
  const output = sm.appendMessage({
    role: "toolResult",
    toolCallId: "test",
    toolName: "test_log",
    content: [{ type: "text", text }],
    isError: true,
    timestamp: Date.now(),
  });
  sm.appendMessage(assistant([{ type: "text", text: "Prior findings. ".repeat(100) }]));
  return { original, output, text, serialized: JSON.stringify(sm.getEntry(output)) };
}

for (const visibility of ["excluded", "available"] as const) {
  test(`real Pi recall ${visibility}: two stock compactions preserve exact originals after resume`, async (t) => {
    const app = await host(t, visibility);
    const evidence = stage(app.sm);
    app.session.agent.state.messages = app.sm.buildSessionContext().messages;
    for (let round = 0; round < 2; round++) {
      await app.session.prompt(
        `Continue investigation ${round}. ` + "Context payload. ".repeat(100),
      );
      await app.session.compact("Preserve original requirements");
    }
    assert.equal(
      app.summaries.length,
      4,
      "Pi summarizes history and split-turn prefixes regardless of tool visibility",
    );
    assert.deepEqual(app.compactionReasons, ["manual", "manual"]);
    const compactions = app.sm.getBranch().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 2);
    assert.ok(
      compactions.every(
        (entry) => !entry.fromHook && entry.summary.startsWith("Stock Pi summary:"),
      ),
    );
    const payload = app.payloads[0]!;
    assert.deepEqual(
      payload.tools?.map((tool) => tool.name) ?? [],
      visibility === "available" ? ["recall"] : [],
    );
    assert.equal(payload.systemPrompt?.includes("Context recall"), visibility === "available");
    assert.equal(
      JSON.stringify(payload.messages).includes("[evidence:"),
      visibility === "available",
    );
    assert.doesNotMatch(JSON.stringify(app.sm.buildSessionContext().messages), /END ORIGINAL/);
    assert.doesNotMatch(
      JSON.stringify(app.sm.getEntries()),
      /\[evidence:/,
      "markers never persist",
    );
    const reopened = SessionManager.open(app.sm.getSessionFile()!);
    assert.equal(JSON.stringify(reopened.getEntry(evidence.output)), evidence.serialized);
    assert.match(
      JSON.stringify(recall(reopened.getBranch(), { entryId: evidence.original })),
      /ORIGINAL USER PAYLOAD/,
    );
    let recovered = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const read = recall(reopened.getBranch(), {
        entryId: evidence.output,
        offset,
        limit: 997,
      }) as { text: string; nextOffset: number | null };
      recovered += read.text;
      offset = read.nextOffset;
    }
    assert.deepEqual(Buffer.from(recovered), Buffer.from(evidence.text));
    let calls = 0;
    const resumed = await host(
      t,
      visibility,
      () => {
        if (visibility === "available" && ++calls === 1)
          return assistant([
            {
              type: "toolCall",
              id: "recover",
              name: "recall",
              arguments: { entryId: evidence.output, limit: 1000 },
            },
          ]);
        return assistant([{ type: "text", text: "Recovered; no deployment." }]);
      },
      { existing: reopened },
    );
    await resumed.session.prompt(
      "Continue the existing task; recover missing original evidence if available.",
    );
    if (visibility === "available")
      assert.match(
        JSON.stringify(resumed.payloads.at(-1)!.messages),
        /FAIL retry_outer expected=3 actual=4/,
      );
    assert.deepEqual(app.errors, []);
    assert.deepEqual(resumed.errors, []);
    const events = diagnostics(reopened.getBranch());
    assert.equal(
      events.filter((event) => event.event === "compaction" && event.outcome === "normal").length,
      2,
    );
    assert.equal(
      events.filter((event) => event.event === "post_compaction_usage").length,
      2,
      JSON.stringify(events),
    );
    assert.doesNotMatch(
      JSON.stringify(events),
      /ORIGINAL|FAIL|summary-free|reset_requested|resumed/,
    );
  });

  for (const trigger of ["threshold", "overflow"] as const) {
    test(`real Pi recall ${visibility}: native ${trigger} compacts normally`, async (t) => {
      let calls = 0;
      const app = await host(
        t,
        visibility,
        () => {
          if (++calls === 1 && trigger === "overflow")
            return {
              ...assistant([]),
              stopReason: "error",
              errorMessage: "maximum context length exceeded",
            };
          return assistant(
            [{ type: "text", text: "Findings. ".repeat(200) }],
            calls === 1 ? 115_000 : 100,
          );
        },
        { auto: true },
      );
      stage(app.sm);
      app.session.agent.state.messages = app.sm.buildSessionContext().messages;
      await app.session.prompt("Continue");
      assert.equal(app.summaries.length, trigger === "threshold" ? 2 : 1);
      assert.deepEqual(app.compactionReasons, [trigger]);
      assert.equal(calls, trigger === "overflow" ? 2 : 1);
      assert.ok(
        app.sm
          .getBranch()
          .filter((entry) => entry.type === "compaction")
          .every((entry) => !entry.fromHook),
      );
      assert.deepEqual(app.errors, []);
    });
  }

  test(`real Pi recall ${visibility}: auto disabled stays disabled at the budget limit`, async (t) => {
    const app = await host(t, visibility, () =>
      assistant([{ type: "text", text: "Final answer" }], 125_000),
    );
    stage(app.sm);
    app.session.agent.state.messages = app.sm.buildSessionContext().messages;
    await app.session.prompt("Finish the task");
    assert.equal(app.payloads.length, 1);
    assert.equal(app.summaries.length, 0);
    assert.deepEqual(app.compactionReasons, []);
    assert.deepEqual(app.errors, []);
  });
}

test("real Pi first request has consistent schemas, standard tool listing and chained guidance", async (t) => {
  const app = await host(t, "available", undefined, { standardPrompt: true });
  for (const preference of ['{"version":4,"mode":"default"}', "corrupt"]) {
    await writeFile(app.path, preference);
    for (const tools of [["recall"], [], ["recall"]]) {
      // Only the caller changes tools; the extension must not override this choice.
      app.session.setActiveToolsByName(tools);
      await app.session.prompt("Follow the original task constraints.");
      const context = app.payloads.at(-1)!;
      assert.deepEqual(context.tools?.map((tool) => tool.name) ?? [], tools);
      assert.equal(context.systemPrompt?.includes("Context recall"), tools.includes("recall"));
      assert.equal(context.systemPrompt?.includes("- recall:"), tools.includes("recall"));
      assert.match(context.systemPrompt!, /Earlier extension instruction/);
      assert.match(context.systemPrompt!, /Later extension instruction/);
      assert.deepEqual(app.session.getActiveToolNames(), tools);
    }
  }
  assert.deepEqual(app.errors, []);
});

test("real resource loader imports recall without commands from disk", async (t) => {
  const root = await temporary(t);
  const entry = join(root, "fixture.ts");
  await writeFile(
    entry,
    `export { default } from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};`,
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
  assert.equal(loaded.extensions[0]!.commands.size, 0);
  assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ["recall"]);
});
