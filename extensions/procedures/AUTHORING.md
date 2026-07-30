# Procedure authoring guide

This guide is injected into the isolated procedure-author agent on every `/proc` creation. The live model catalog is appended separately for the current Pi session.

## Design contract

A procedure is orchestration code, not implementation code. JavaScript decides **when**, **what can run in parallel**, **what evidence moves forward**, **where approval is required**, and **when to stop**. Child Pi agents inspect or change the project.

Use the smallest useful workflow:

1. Split only genuinely independent investigation into parallel agents.
2. Give each agent one concrete deliverable and the minimum tools.
3. Keep intermediate results in script variables.
4. Pass only relevant evidence into later prompts.
5. Use a stronger model or higher thinking level only for work that benefits from it.
6. Put approval before the first mutation or shell task.
7. Bound every loop and await every `$` operation.
8. Return a small JSON-serializable result.

## Model and thinking selection

The prompt includes a JSON catalog of every model currently approved for Procedures and available to the Pi session, including scoped-model restrictions, supported thinking levels, context/output limits, input capabilities, published cost metadata, and a `usageProfile` for each model. The current deployment policy allows only `openai-codex/gpt-5.6-luna`, `openai-codex/gpt-5.6-terra`, `openai-codex/gpt-5.6-sol`, and `xai/grok-4.5`; unavailable entries are omitted. Each usage profile lists metadata-backed strengths, recommended uses, uses to avoid, relative cost, and explicitly labeled model-name inferences.

Pi's registry does not provide measured quality or latency benchmarks. Therefore, capability/cost recommendations are factual, while traits inferred from names such as `mini`, `flash`, `codex`, or `pro` are hints rather than guarantees. Use observed results when they contradict a hint.

Catalog shape:

```json
{
  "catalogVersion": 1,
  "selectionRules": ["..."],
  "models": [
    {
      "reference": "provider/model-id",
      "current": true,
      "thinkingLevels": ["off", "low", "medium", "high"],
      "contextWindow": 200000,
      "maxOutputTokens": 32000,
      "input": ["text", "image"],
      "costPerMillionTokensUsd": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "usageProfile": {
        "metadataBackedStrengths": ["..."],
        "inferredTraits": ["..."],
        "recommendedFor": ["..."],
        "avoidFor": ["..."],
        "relativePublishedCost": "lower | middle | higher | unreported-or-included"
      }
    }
  ]
}
```

- Use only exact `provider/model-id` references from that catalog. Never invent a model.
- Omit `model` to inherit the outer session model.
- Omit `thinking` to inherit the outer session thinking level, clamped to the selected model.
- Prefer a faster/lower-cost model with `off`, `minimal`, or `low` thinking for narrow discovery, file location, and mechanical checks.
- Prefer a more capable model with `medium` or `high` thinking for architecture, adversarial review, synthesis, and risky implementation decisions.
- Do not use `xhigh` or `max` unless the catalog supports it and the task clearly justifies the latency/cost.
- Select models by task fit, not variety: spend the strongest suitable model/reasoning on the highest-leverage planning, synthesis, review, or implementation task, and use cheaper settings for bounded scouts. Explain the allocation with `$.log` or an artifact.
- Parallel tasks may deliberately use different models when their roles benefit from different strengths.
- If only one model is available, optimize with thinking levels rather than inventing alternatives.

Agent options:

```js
{
  tools: ["read", "grep", "find", "ls"],
  model: "exact-provider/exact-model-id", // optional; must be in the live catalog
  thinking: "low",                       // optional; must be supported by that model
  retries: 1,                             // read-only only; host caps at 2
  timeoutMs: 600000,
}
```

## Good example

```js
await $.phase("recon");
await $.log("Using lightweight parallel scouts before one deeper synthesis pass.");

const [surface, tests] = await Promise.all([
  $.agent(
    "surface-scout",
    "Locate the relevant public API and return only paths, symbols, and constraints.",
    {
      tools: ["read", "grep", "find", "ls"],
      model: "<exact fast model from the live catalog>",
      thinking: "low",
      retries: 1,
    },
  ),
  $.agent("test-scout", "Locate relevant tests and summarize coverage gaps with file references.", {
    tools: ["read", "grep", "find", "ls"],
    model: "<exact fast model from the live catalog>",
    thinking: "low",
    retries: 1,
  }),
]);

await $.artifact("recon", {
  surface: surface.text.slice(0, 12000),
  tests: tests.text.slice(0, 12000),
});

const plan = await $.agent(
  "planner",
  `Produce a minimal implementation plan from this evidence.\nAPI:\n${surface.text}\nTESTS:\n${tests.text}`,
  {
    tools: ["read", "grep", "find", "ls"],
    model: "<exact capable model from the live catalog>",
    thinking: "high",
  },
);

if (!(await $.approval("Apply the reviewed plan?", plan.text.slice(0, 6000)))) {
  return { status: "declined", plan: plan.text };
}

await $.phase("implementation");
const implementation = await $.agent("implementer", `Implement this plan:\n${plan.text}`, {
  tools: ["read", "grep", "find", "ls", "edit", "write"],
  model: "<exact capable model from the live catalog>",
  thinking: "high",
});

await $.phase("verification");
const verification = await $.agent(
  "verifier",
  "Inspect the implementation and run the narrowest relevant checks.",
  {
    tools: ["read", "grep", "find", "ls", "bash"],
    model: "<exact verification model from the live catalog>",
    thinking: "medium",
  },
);

return {
  status: "complete",
  implementation: implementation.text,
  verification: verification.text,
};
```

The angle-bracket model references above are documentation placeholders only. Replace every one with an exact live-catalog reference before submitting.

## Bad examples

### One giant agent

```js
return $.agent(
  "do-everything",
  "Inspect, plan, edit, test, review, and summarize the whole project.",
  {
    tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
  },
);
```

Why bad: no useful isolation, no parallelism, no checkpoint, excessive authority, and poor visibility.

### Unbounded or model-controlled looping

```js
while (true) {
  await $.agent("try-again", "Keep trying until you think it is good.", {
    tools: ["read", "edit"],
  });
}
```

Why bad: no deterministic stop condition and repeated side effects.

### Fire-and-forget work

```js
$.agent("background-edit", "Change the files.", { tools: ["edit", "write"] });
return { status: "done" };
```

Why bad: the procedure returns before side effects finish. The runtime rejects unawaited host operations.

### Retrying side effects

```js
await $.agent("writer", "Make the change.", {
  tools: ["edit", "write"],
  retries: 2,
});
```

Why bad: mutation may already have happened before a failure. The host disables retries for mutation and shell tasks.

### Invented or unsupported model

```js
await $.agent("review", "Review deeply.", {
  model: "vendor/imaginary-ultra-model",
  thinking: "max",
});
```

Why bad: the model may not exist, may be outside the current scoped-model set, or may not support that thinking level.

### Context dumping

```js
const scans = await Promise.all(
  hugeFileList.map((path) => $.agent(path, `Return the entire file ${path}.`)),
);
return $.agent("synthesis", JSON.stringify(scans));
```

Why bad: fan-out is unbounded and all raw output is copied into another model context. Use bounded thematic scouts and compressed evidence.

## Submission checklist

Before `submit_procedure`, verify:

- Every model reference exactly matches the live catalog.
- Every requested thinking level is listed for that model.
- Independent tasks use `Promise.all`; dependent tasks are sequential.
- Every `$` call is awaited.
- All loops have explicit small bounds.
- Tools are minimal and `requiredTools` includes their union.
- Mutation/shell work follows an approval checkpoint.
- Mutation/shell work does not request retries.
- Prompts have concrete deliverables and scope.
- The returned value is bounded and JSON-serializable.
