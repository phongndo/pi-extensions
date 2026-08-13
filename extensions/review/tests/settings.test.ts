import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultSettings,
  loadSettings,
  normalizeSettings,
  ReviewLoopSettingsStore,
  saveSettings,
} from "../settings.ts";

test("defaults and migrates the pre-versioned shape", () => {
  assert.deepEqual(defaultSettings(), {
    version: 3,
    reviewMode: "standard",
    reviewerCount: 1,
    maximumPasses: 4,
    requiredCleanRuns: 1,
    fixP3Findings: true,
    fixerContext: "continuous",
  });
  assert.deepEqual(
    normalizeSettings({
      maxPasses: 6,
      requiredCleanRuns: 2,
      fixP3: false,
      fixerContext: "fresh",
      reviewerModel: "openai/gpt-test",
    }),
    {
      version: 3,
      reviewMode: "standard",
      reviewerCount: 1,
      maximumPasses: 6,
      requiredCleanRuns: 2,
      fixP3Findings: false,
      fixerContext: "fresh",
      reviewerModel: { provider: "openai", modelId: "gpt-test" },
      verifierModel: { provider: "openai", modelId: "gpt-test" },
    },
  );
});

test("supports an unlimited pass cap", () => {
  assert.equal(
    normalizeSettings({ maximumPasses: "unlimited", requiredCleanRuns: 20 }).maximumPasses,
    "unlimited",
  );
  assert.throws(
    () => normalizeSettings({ maximumPasses: "unlimited", requiredCleanRuns: 21 }),
    /between 1 and 20/,
  );
});

test("rejects invalid ranges and model references", () => {
  assert.throws(() => normalizeSettings({ maximumPasses: 0 }), /between 1 and 20/);
  assert.throws(
    () => normalizeSettings({ maximumPasses: 2, requiredCleanRuns: 3 }),
    /between 1 and 2/,
  );
  assert.throws(() => normalizeSettings({ reviewerModel: "missing-slash" }), /provider\/model/);
  assert.throws(() => normalizeSettings({ reviewerThinking: "ultra" }), /not a supported/);
  assert.throws(() => normalizeSettings({ verifierThinking: "ultra" }), /not a supported/);
  assert.throws(() => normalizeSettings({ reviewMode: "hostile" }), /reviewMode must be one of/);
  assert.throws(() => normalizeSettings({ reviewerCount: 0 }), /between 1 and 8/);
  assert.throws(() => normalizeSettings({ reviewerCount: 9 }), /between 1 and 8/);
  assert.equal(normalizeSettings({ version: 1 }).version, 3);
  assert.equal(normalizeSettings({ version: 2 }).version, 3);
  assert.equal(
    normalizeSettings({
      version: 2,
      reviewerThinking: "max",
      reviewerModel: "openai/reviewer",
    }).verifierThinking,
    "max",
  );
  assert.deepEqual(
    normalizeSettings({
      version: 2,
      reviewerModel: "openai/reviewer",
    }).verifierModel,
    { provider: "openai", modelId: "reviewer" },
  );
  assert.equal(
    normalizeSettings({
      version: 3,
      reviewerModel: "openai/reviewer",
    }).verifierModel,
    undefined,
  );
  assert.equal(normalizeSettings({ reviewMode: "adversarial" }).reviewMode, "adversarial");
  assert.equal(normalizeSettings({ reviewMode: "adversarial" }).reviewerCount, 2);
  assert.equal(normalizeSettings({ reviewMode: "adversarial", reviewerCount: 4 }).reviewerCount, 4);
  assert.equal(normalizeSettings({ reviewMode: "security" }).reviewMode, "adversarial");
  assert.equal(normalizeSettings({ reviewMode: "migration" }).reviewMode, "adversarial");
  assert.throws(() => normalizeSettings({ version: 99 }), /Unsupported/);
});

test("rejects unknown settings and model-reference fields", () => {
  assert.throws(
    () => normalizeSettings({ verificationComand: "pnpm test" }),
    /unknown field: verificationComand/,
  );
  assert.throws(
    () =>
      normalizeSettings({
        reviewerModel: { provider: "openai", modelId: "gpt-test", modelID: "typo" },
      }),
    /unknown field: modelID/,
  );
});

test("persists atomically and reports corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-loop-settings-"));
  const path = join(directory, "nested", "review-loop.json");
  const settings = defaultSettings();
  settings.verificationCommand = "pnpm test";
  await saveSettings(settings, path);
  assert.deepEqual(await loadSettings(path), settings);
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { version: number }).version, 3);

  await writeFile(
    path,
    '{"version":2,"maximumPasses":6,"reviewerModel":"openai/reviewer","reviewerThinking":"high"}',
    "utf8",
  );
  const migrated = await loadSettings(path);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.maximumPasses, 6);
  assert.deepEqual(migrated.verifierModel, { provider: "openai", modelId: "reviewer" });
  assert.equal(migrated.verifierThinking, "high");
  assert.equal((JSON.parse(await readFile(path, "utf8")) as { version: number }).version, 3);

  await writeFile(path, '{"verificationComand":"pnpm test"}', "utf8");
  await assert.rejects(loadSettings(path), /Invalid review-loop settings.*verificationComand/);

  await writeFile(path, "{bad", "utf8");
  await assert.rejects(loadSettings(path), /Malformed JSON/);
});

test("serializes immediate store updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "review-loop-store-"));
  const path = join(directory, "review-loop.json");
  const store = new ReviewLoopSettingsStore(defaultSettings(), path);
  const first = store.update((settings) => {
    settings.maximumPasses = 8;
  });
  const second = store.update((settings) => {
    settings.fixP3Findings = false;
  });
  await Promise.all([first, second]);
  await store.flush();
  const loaded = await loadSettings(path);
  assert.equal(loaded.maximumPasses, 8);
  assert.equal(loaded.fixP3Findings, false);
});
