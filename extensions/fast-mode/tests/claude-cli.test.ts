import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { REQUEST_SPEED, type RequestSpeedOptions } from "../../../src/request-speed.ts";
import { resolveFastCapability } from "../capabilities.ts";
import { applyCodexFastMode, withFastPayload } from "../policy.ts";

/**
 * A model as pi-claude-cli registers it. The patched provider
 * (patches/pi-claude-cli.patch) advertises `serviceTiers: [{ id: "fast" }]` on its Fast models.
 */
function cliModel(id: string, fast: boolean | undefined): Model<Api> {
  return {
    id,
    name: id,
    provider: "pi-claude-cli",
    api: "pi-claude-cli",
    baseUrl: "pi-claude-cli",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
    ...(fast === undefined ? {} : { serviceTiers: fast ? [{ id: "fast" }] : [] }),
  } as Model<Api>;
}

/** The provider's launch payload after the policy's `onPayload` hook. */
async function launch(model: Model<Api>, options: StreamOptions) {
  const payload = { model: model.id };
  return (await options.onPayload?.(payload, model)) ?? payload;
}

const FAST_LAUNCH = { model: "claude-opus-5-5", speed: "fast", usageCredits: "allow" };

test("the patched provider's Fast models are supported, Ultrafast is not", () => {
  const opus = resolveFastCapability(cliModel("claude-opus-5-5", true));
  assert.equal(opus.status, "supported");
  assert.equal(opus.ultrafast, "unsupported");
  assert.equal(opus.source, "model");
  assert.equal(resolveFastCapability(cliModel("claude-haiku-4-5", false)).status, "unsupported");
});

test("an unpatched pi-claude-cli is never reported as Fast", () => {
  const model = cliModel("claude-opus-5-5", undefined);
  const capability = resolveFastCapability(model);
  assert.equal(capability.status, "unsupported");
  assert.match(capability.reason, /patches\/apply-pi-claude-cli\.sh/);
  const payload = { model: model.id };
  assert.equal(applyCodexFastMode(payload, model, "fast"), payload);
});

test("Fast and Ultrafast both ask for fast mode and consent to usage credits; Off does not", async () => {
  const model = cliModel("claude-opus-5-5", true);
  for (const preference of ["fast", "ultrafast"] as const)
    assert.deepEqual(
      await launch(
        model,
        withFastPayload({}, async () => preference),
      ),
      FAST_LAUNCH,
    );
  assert.deepEqual(
    await launch(
      model,
      withFastPayload({}, async () => "off"),
    ),
    {
      model: model.id,
    },
  );
  const haiku = cliModel("claude-haiku-4-5", false);
  assert.deepEqual(
    await launch(
      haiku,
      withFastPayload({}, async () => "fast"),
    ),
    {
      model: haiku.id,
    },
  );
});

test("a request-level Standard override wins over the global preference", async () => {
  const options: StreamOptions & RequestSpeedOptions = {
    [REQUEST_SPEED]: { preference: "standard" },
  };
  const model = cliModel("claude-opus-5-5", true);
  assert.deepEqual(
    await launch(
      model,
      withFastPayload(options, async () => "fast"),
    ),
    {
      model: model.id,
    },
  );
  assert.deepEqual(options[REQUEST_SPEED]?.report?.(), {
    preferred: "standard",
    requested: "standard",
  });
});

test("Fable needs an explicit advisor opt-in, as on the Anthropic API", async () => {
  const fable = cliModel("claude-fable-5-2", true);
  const inherit: StreamOptions & RequestSpeedOptions = {
    [REQUEST_SPEED]: { preference: "inherit" },
  };
  assert.deepEqual(
    await launch(
      fable,
      withFastPayload(inherit, async () => "fast"),
    ),
    {
      model: fable.id,
    },
  );
  const fast: StreamOptions & RequestSpeedOptions = { [REQUEST_SPEED]: { preference: "fast" } };
  assert.deepEqual(
    await launch(
      fable,
      withFastPayload(fast, async () => "off"),
    ),
    {
      model: fable.id,
      speed: "fast",
      usageCredits: "allow",
    },
  );
  // The executor (no request-level override) follows the global preference on Fable too.
  assert.deepEqual(
    await launch(
      fable,
      withFastPayload({}, async () => "fast"),
    ),
    {
      model: fable.id,
      speed: "fast",
      usageCredits: "allow",
    },
  );
});
