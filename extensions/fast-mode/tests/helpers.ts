import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { Model } from "@earendil-works/pi-ai";

export function model(id = "gpt-6-astra"): Model<"openai-codex-responses"> {
  return {
    id,
    name: id,
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 32_000,
  };
}

export function token(account = "test-account"): string {
  return `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test`;
}

export function catalog(models: unknown[]): Response {
  return Response.json({ models });
}

export async function eventually(
  predicate: () => boolean,
  message = "condition did not become true",
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.equal(predicate(), true, message);
}
