import assert from "node:assert/strict";
import test from "node:test";
import { formatModelCatalog } from "../author.ts";
import { PROCEDURE_MODEL_ALLOWLIST } from "../models.ts";

test("procedure model policy is restricted to the approved four models", () => {
  assert.deepEqual(PROCEDURE_MODEL_ALLOWLIST, [
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-sol",
    "xai/grok-4.5",
  ]);
});

test("procedure author receives an availability-only model catalog", () => {
  const catalog = JSON.parse(
    formatModelCatalog([
      {
        reference: "openai-codex/gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        thinkingLevels: ["off", "low"],
        contextWindow: 128_000,
        maxOutputTokens: 16_000,
        input: ["text"],
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
        current: true,
      },
    ]),
  ) as { models: Array<Record<string, unknown>>; selectionRules: string[] };
  const model = catalog.models[0];
  assert.equal(model?.reference, "openai-codex/gpt-5.6-luna");
  assert.equal(model?.current, true);
  assert.deepEqual(model?.thinkingLevels, ["off", "low"]);
  assert.match(JSON.stringify(model?.usageProfile), /implementation/);
  assert.match(JSON.stringify(model?.usageProfile), /explicit high reasoning/);
  assert.ok(catalog.selectionRules.length > 0);
  assert.equal("apiKey" in (model ?? {}), false);
});
