import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createReadToolDefinition,
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createChildModelRuntime,
  createChildSession,
  disposeChildSession,
  promptChild,
} from "../child-session.ts";
import type { UsageSummary } from "../models.ts";

const MODEL = {
  id: "model",
  name: "Model",
  reasoning: false,
  input: ["text"] as const,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_000,
  maxTokens: 1_000,
};

async function seedRuntime(agentDir: string): Promise<{
  runtime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
}> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
  });
  runtime.registerProvider("seed", {
    baseUrl: "https://example.invalid/v1",
    apiKey: "seed-key",
    api: "openai-completions",
    models: [{ ...MODEL, input: ["text"] }],
  });
  const model = runtime.getModel("seed", "model");
  assert.ok(model);
  return { runtime, model };
}

test("child sessions load additional outer extension entry points", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-extension-"));
  const agentDir = join(root, "agent");
  const extensionPath = join(root, "provider-extension.ts");
  await writeFile(
    extensionPath,
    `export default function (pi) {
      const provider = (id) => ({
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        api: "openai-completions",
        models: [{
          id: "extension-model",
          name: "Extension Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000
        }]
      });
      pi.registerProvider("child-extension-provider", provider());
      pi.on("session_start", () => {
        pi.registerProvider("child-session-start-provider", provider());
      });
    }`,
    "utf8",
  );

  const outerRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "outer-auth.json"),
    modelsPath: null,
  });
  outerRuntime.registerProvider("seed", {
    baseUrl: "https://example.invalid/v1",
    apiKey: "seed-key",
    api: "openai-completions",
    models: [{ ...MODEL, input: ["text"] }],
  });
  outerRuntime.registerProvider("outer-only-provider", {
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    api: "openai-completions",
    models: [{ ...MODEL, id: "outer-model", input: ["text"] }],
  });
  const runtime = await createChildModelRuntime(new ModelRegistry(outerRuntime));
  const model = runtime.getModel("seed", "model");
  assert.ok(model);

  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    projectTrusted: false,
    additionalExtensionPaths: [extensionPath],
  });
  try {
    assert.ok(runtime.getModel("child-extension-provider", "extension-model"));
    assert.ok(runtime.getModel("child-session-start-provider", "extension-model"));
    assert.ok(runtime.getModel("outer-only-provider", "outer-model"));
    assert.deepEqual(session.getActiveToolNames(), ["read"]);
  } finally {
    await disposeChildSession(session);
  }

  await assert.rejects(
    createChildSession({
      cwd: root,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      systemPrompt: "Test role",
      tools: ["read"],
      customTools: [createReadToolDefinition(root)],
      contextFiles: [],
      projectTrusted: false,
      additionalExtensionPaths: [join(root, "missing-extension.ts")],
    }),
    /Could not load review-loop child extensions:.*does not exist/,
  );
});

test("child sessions can enable general bash without edit or write", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-bash-"));
  const agentDir = join(root, "agent");
  const { runtime, model } = await seedRuntime(agentDir);
  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read", "bash"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    projectTrusted: false,
    extensionsEnabled: false,
  });
  try {
    assert.deepEqual(session.getActiveToolNames(), ["read", "bash"]);
  } finally {
    await disposeChildSession(session);
  }
});

test("child sessions honor disabled discovery while retaining explicit extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-no-discovery-"));
  const agentDir = join(root, "agent");
  const configuredMarker = join(root, "configured.txt");
  const explicitMarker = join(root, "explicit.txt");
  await mkdir(agentDir, { recursive: true });
  const extension = (marker: string) => `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "loaded");
export default function () {}`;
  await writeFile(join(agentDir, "configured.ts"), extension(configuredMarker));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["./configured.ts"] }),
  );
  const explicit = join(root, "explicit.ts");
  await writeFile(explicit, extension(explicitMarker));

  const { runtime, model } = await seedRuntime(agentDir);
  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    projectTrusted: true,
    additionalExtensionPaths: [explicit],
    discoverExtensions: false,
  });
  try {
    assert.equal(await readFile(explicitMarker, "utf8"), "loaded");
    await assert.rejects(readFile(configuredMarker, "utf8"), /ENOENT/);
  } finally {
    await disposeChildSession(session);
  }
});

test("child sessions hide skills bundled with additional extension packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-package-skills-"));
  const agentDir = join(root, "agent");
  const packageDir = join(root, "role-package");
  const marker = join(root, "extension-started.txt");
  await mkdir(join(packageDir, "skills", "injected"), { recursive: true });
  await writeFile(
    join(packageDir, "extension.ts"),
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => writeFileSync(${JSON.stringify(marker)}, "started"));
}`,
  );
  await writeFile(
    join(packageDir, "skills", "injected", "SKILL.md"),
    `---\nname: injected\ndescription: Injected role instructions\n---\nUNTRUSTED_SKILL_SENTINEL\n`,
  );
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      type: "module",
      pi: { extensions: ["./extension.ts"], skills: ["./skills"] },
    }),
  );

  const { runtime, model } = await seedRuntime(agentDir);
  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    projectTrusted: false,
    additionalExtensionPaths: [packageDir],
  });
  try {
    assert.equal(await readFile(marker, "utf8"), "started");
    assert.deepEqual(session.resourceLoader.getSkills().skills, []);
    assert.deepEqual(session.resourceLoader.getPrompts().prompts, []);
    assert.doesNotMatch(session.systemPrompt, /UNTRUSTED_SKILL_SENTINEL/);
  } finally {
    await disposeChildSession(session);
  }
});

test("child sessions preserve global and project package scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-scopes-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, ".pi");
  const marker = join(root, "hooks.txt");
  await mkdir(join(agentDir, "global-package"), { recursive: true });
  await mkdir(join(projectDir, "project-package"), { recursive: true });

  const extension = (name: string) => `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${name}\n`)}));
}`;
  await writeFile(join(agentDir, "global-package", "global.ts"), extension("global-package"));
  await writeFile(
    join(agentDir, "global-package", "package.json"),
    JSON.stringify({ type: "module", pi: { extensions: ["./global.ts"] } }),
  );
  await writeFile(join(projectDir, "project-package", "project.ts"), extension("project-package"));
  await writeFile(
    join(projectDir, "project-package", "package.json"),
    JSON.stringify({ type: "module", pi: { extensions: ["./project.ts"] } }),
  );
  await writeFile(join(projectDir, "hook-only.ts"), extension("project-hook-only"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["./global-package"] }),
  );
  await writeFile(
    join(projectDir, "settings.json"),
    JSON.stringify({ packages: ["./project-package"], extensions: ["./hook-only.ts"] }),
  );

  const { runtime, model } = await seedRuntime(agentDir);
  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    projectTrusted: true,
  });
  try {
    assert.deepEqual((await readFile(marker, "utf8")).trim().split("\n").sort(), [
      "global-package",
      "project-hook-only",
      "project-package",
    ]);
  } finally {
    await disposeChildSession(session);
  }
});

function assistantEvent(
  stopReason: "stop" | "error",
  input: number,
  errorMessage?: string,
): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason,
      errorMessage,
      usage: {
        input,
        output: input,
        cacheRead: input,
        cacheWrite: input,
        totalTokens: input * 4,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
      },
      timestamp: Date.now(),
      provider: "test",
      model: "model",
      api: "openai-completions",
    },
  } as unknown as AgentSessionEvent;
}

function eventSession(events: AgentSessionEvent[]): AgentSession {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    messages: [],
    subscribe(next: (event: AgentSessionEvent) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async prompt() {
      for (const event of events) {
        listener?.(event);
      }
    },
    abort() {
      return undefined;
    },
  } as unknown as AgentSession;
}

test("promptChild tracks event usage across transcript rewrites", async () => {
  const compaction = {
    type: "compaction_end",
    reason: "threshold",
    result: {
      summary: "summary",
      firstKeptEntryId: "entry",
      tokensBefore: 100,
      usage: {
        input: 2,
        output: 2,
        cacheRead: 2,
        cacheWrite: 2,
        totalTokens: 8,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      },
    },
    aborted: false,
    willRetry: false,
  } as unknown as AgentSessionEvent;
  const child = await promptChild(
    eventSession([assistantEvent("error", 1, "retryable"), compaction, assistantEvent("stop", 3)]),
    "prompt",
  );
  assert.equal(child.messages.length, 2);
  assert.deepEqual(child.usage, {
    input: 6,
    output: 6,
    cacheRead: 6,
    cacheWrite: 6,
    cost: 6,
    turns: 3,
  });
});

test("promptChild reports usage before propagating a final assistant error", async () => {
  const reported: UsageSummary[] = [];
  await assert.rejects(
    promptChild(
      eventSession([assistantEvent("error", 1, "final failure")]),
      "prompt",
      undefined,
      (usage) => reported.push(usage),
    ),
    /final failure/,
  );
  assert.deepEqual(reported, [
    { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1, turns: 1 },
  ]);
});

test("promptChild closes the abort race before starting a prompt", async () => {
  const controller = new AbortController();
  let promptCalls = 0;
  let abortCalls = 0;
  const session = {
    subscribe() {
      controller.abort();
      return () => undefined;
    },
    async prompt() {
      promptCalls += 1;
    },
    async abort() {
      abortCalls += 1;
    },
  } as unknown as AgentSession;

  await assert.rejects(
    promptChild(session, "prompt", controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(promptCalls, 0);
  assert.equal(abortCalls, 1);
});

test("promptChild handles and reports abort rejections", async () => {
  const controller = new AbortController();
  const session = {
    subscribe() {
      controller.abort();
      return () => undefined;
    },
    async prompt() {
      throw new Error("prompt must not start");
    },
    async abort() {
      throw new Error("abort failed");
    },
  } as unknown as AgentSession;

  await assert.rejects(promptChild(session, "prompt", controller.signal), /abort failed/);
});

test("extension-disabled child sessions execute no project or additional extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-loop-child-pr-"));
  const agentDir = join(root, "agent");
  const marker = join(root, "executed.txt");
  await mkdir(join(root, ".pi", "extensions"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const malicious = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
export default function () {}`;
  const discovered = join(root, ".pi", "extensions", "evil.ts");
  const additional = join(root, "additional-evil.ts");
  await writeFile(discovered, malicious);
  await writeFile(additional, malicious);
  await writeFile(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ extensions: ["./extensions/evil.ts"] }),
  );

  const { runtime, model } = await seedRuntime(agentDir);
  const session = await createChildSession({
    cwd: root,
    agentDir,
    modelRuntime: runtime,
    model,
    thinkingLevel: "off",
    systemPrompt: "Test role",
    tools: ["read"],
    customTools: [createReadToolDefinition(root)],
    contextFiles: [],
    // Extension disabling overrides both project trust and explicit entry points.
    projectTrusted: true,
    additionalExtensionPaths: [additional],
    extensionsEnabled: false,
  });
  try {
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
  } finally {
    await disposeChildSession(session);
  }
});
