# Pi Procedures

> Visibility-first, code-driven multi-agent workflows for Pi: generate a small orchestration program, review it, approve its capabilities, run it in the background, and watch every task in `/monitor`.

Procedures are for work that needs more structure than one agent turn but less machinery than a workflow DSL. Ordinary JavaScript owns branching, loops, fan-out/fan-in, approvals, and intermediate state. Isolated Pi `AgentSession`s own judgment and project interaction.

Generated procedures are **ephemeral by default**. Nothing enters `.pi/procedures/` unless you explicitly promote a run with `/proc save`.

## At a glance

|                      |                                                         |
| -------------------- | ------------------------------------------------------- |
| Create/run           | `/proc`                                                 |
| Live dashboard       | `/monitor`                                              |
| Agent-visible status | `procedure_status`                                      |
| Execution            | Background, bounded worker + isolated child sessions    |
| Default concurrency  | 4 child agents                                          |
| Maximum tasks        | 64 per run                                              |
| Run timeout          | 4 hours                                                 |
| Persistence          | Private run snapshots; explicit project-local promotion |
| Project requirement  | Trusted project, TUI mode                               |

## Quick start

Ask Procedures to design a workflow:

```text
/proc Inspect the authentication change, run independent API and test scouts in parallel, propose the smallest safe plan, ask before editing, implement it, and run focused verification.
```

The lifecycle is intentionally reviewable:

1. An isolated author agent inspects the project and writes a JavaScript function body.
2. Pi opens the generated source in an editor. Review or modify it.
3. Pi shows the union of child-agent tools and warns about mutation/shell access.
4. You approve or cancel launch.
5. The run starts in the background.
6. `/monitor` shows phases, tasks, tools, models, reasoning, usage, artifacts, approvals, and results.
7. The source remains private to that run unless you save it explicitly.

Open the dashboard:

```text
/monitor
```

Promote a useful workflow only after observing it:

```text
/proc save <run-id> auth-change-workflow
```

Rerun it later:

```text
/proc run auth-change-workflow "Apply the same process to the session-token change"
```

## Command reference

```text
/proc <goal>                 generate, review, and launch an ephemeral procedure
/proc create <goal>          explicit form of the same command
/proc save <run-id> [name]   promote one run into a reusable project procedure
/proc run <name> [goal]      rerun saved source; optional goal replaces the saved goal
/proc list                   list saved procedures and their allowed tools
/proc stop <run-id>          stop an active run
/proc approve <run-id>       approve a waiting checkpoint
/proc deny <run-id>          deny a waiting checkpoint
/monitor [run-id]            open the live dashboard, optionally focused on one run
```

Full or unique run-ID prefixes are accepted where the registry can resolve them unambiguously.

`/proc` and `/monitor` currently require TUI mode. Creating or running a procedure also requires a trusted project.

## Monitor controls

| Key       | Action                                      |
| --------- | ------------------------------------------- |
| `↑` / `↓` | Select run or task                          |
| `Enter`   | Drill into the selected run/task            |
| `Esc`     | Move back or close                          |
| `p`       | Pause/resume new scheduling                 |
| `x`       | Stop the selected run                       |
| `a`       | Approve a waiting `$.approval()` checkpoint |
| `d`       | Deny a waiting checkpoint                   |

Pausing does not kill an already-running child; it prevents new tasks from acquiring a scheduling slot. Stopping aborts the worker and active child sessions but does not revert completed file edits.

A compact widget below the editor shows active runs and current task activity while the dashboard is closed.

## Procedure source model

Source is an async function **body**, not a module:

```js
await $.phase("inspect");

const [api, tests] = await Promise.all([
  $.agent("api-scout", "Inspect the API boundary. Return paths, symbols, and constraints.", {
    tools: ["read", "grep", "find", "ls"],
    model: "openai-codex/gpt-5.6-terra",
    thinking: "low",
    retries: 1,
  }),
  $.agent("test-scout", "Find relevant tests and concrete coverage gaps.", {
    tools: ["read", "grep", "find", "ls"],
    model: "openai-codex/gpt-5.6-sol",
    thinking: "low",
    retries: 1,
  }),
]);

await $.artifact("inspection", {
  api: api.text.slice(0, 12000),
  tests: tests.text.slice(0, 12000),
});

if (!(await $.approval("Apply the implementation?", `${api.text}\n\n${tests.text}`))) {
  return { status: "declined" };
}

await $.phase("implement");
const implementation = await $.agent(
  "implementer",
  `Implement the requested goal using this evidence:\n${api.text}\n${tests.text}`,
  {
    tools: ["read", "grep", "find", "ls", "edit", "write"],
    model: "openai-codex/gpt-5.6-luna",
    thinking: "high",
  },
);

return {
  status: "complete",
  summary: implementation.text,
};
```

Every `$` operation returns a promise and must be awaited. Unawaited host work prevents the procedure from reporting successful completion.

## Procedure API

### `$.input`

Frozen JSON input. Command-launched procedures receive:

```json
{
  "goal": "the effective run goal"
}
```

### `await $.phase(name)`

Sets the visible phase label. Use phases for meaningful workflow boundaries such as `recon`, `plan`, `implementation`, and `verification`.

### `await $.agent(id, prompt, options?)`

Runs one isolated Pi child session and returns:

```js
{
  taskId: "...",
  text: "bounded child result",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  },
}
```

Options:

```js
{
  tools: ["read", "grep", "find", "ls"],
  model: "provider/model-id",
  thinking: "low",
  retries: 1,
  timeoutMs: 1200000,
}
```

- `tools`: smallest needed subset of `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`.
- `model`: exact reference from the live approved catalog; omit to inherit the run default.
- `thinking`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; must be allowed for the model.
- `retries`: 0–2 for read-only tasks. Mutation or shell tasks are forced to zero retries.
- `timeoutMs`: per-task timeout, capped at one hour; default 20 minutes.

Use `Promise.all` for independent tasks. The host limits actual concurrency to four.

### `await $.log(message, data?)`

Adds a bounded monitor-visible event. Good logs explain routing decisions, skipped branches, or why a model/reasoning level was chosen.

### `await $.artifact(name, value)`

Persists one JSON-serializable intermediate result for inspection in `/monitor`. Runs allow up to 30 artifacts, each at most 64 KiB.

### `await $.approval(label, details?)`

Pauses the run until approved or denied. Put an approval before the first mutation or shell task and include enough detail for an informed decision. Returns `true` for approval and `false` for denial.

### `await $.sleep(ms)`

Sleeps for 0–60,000 ms. It exists for bounded polling/backoff, not indefinite scheduling.

## Model policy and task routing

Procedures currently permit only:

```text
openai-codex/gpt-5.6-luna
openai-codex/gpt-5.6-terra
openai-codex/gpt-5.6-sol
xai/grok-4.5
```

The effective catalog is the intersection of:

1. this allowlist;
2. models authenticated and available to Pi; and
3. `ctx.scopedModels`, when the session supplies a scope.

If the current Pi model is approved, it becomes the default. Otherwise Procedures prefers Luna, then the next available approved model. Both the author session and child-agent defaults stay inside the policy.

The author receives a live JSON catalog for every usable model with:

- exact reference and display name;
- current/default marker;
- supported or pinned thinking levels;
- context and maximum output tokens;
- text/image capability;
- published input/output/cache cost;
- metadata-backed strengths;
- explicitly labeled name-based inferences;
- recommended roles and roles to avoid;
- relative published cost inside the catalog.

Selection guidance tells the author to choose by **task fit**, not by variety: concentrate the strongest suitable model/reasoning on high-leverage architecture, implementation, synthesis, or adversarial review, and use cheaper/lower reasoning for narrow scouts.

Pi does not publish benchmark quality or latency in its registry. Procedures does not fabricate those rankings. Name-based traits are labeled as hints. Unknown, unauthenticated, out-of-scope, or disallowed models fail closed at execution.

The effective model and clamped thinking level appear on every task in `/monitor` and `procedure_status`.

## How the author learns to write procedures

The author does not rely on a vague one-line prompt. Every creation receives:

- the complete runtime/API contract;
- the live model JSON catalog;
- decomposition and model-allocation rules;
- good and bad orchestration examples;
- approval, retry, and side-effect rules;
- context-compression guidance;
- a final submission checklist.

The injected guide is [`AUTHORING.md`](AUTHORING.md). It explicitly rejects giant all-powerful agents, unbounded loops, fire-and-forget host work, mutation retries, invented models, and context dumping.

The generated source must parse, stay under 64 KiB, and cannot use imports, `require`, `process`, `globalThis`, dynamic code generation, or WebAssembly. You still review the source before launch.

## Persistence and saved procedures

### Ephemeral runs

Generated source and snapshots are stored privately under:

```text
~/.pi/agent/procedure-runs/<project-hash>/
```

The project path is hashed, and up to 100 historical snapshots are restored for monitoring. Active runs do not survive Pi process exit or `/reload`; durable active snapshots are marked `interrupted`, never silently treated as complete.

### Explicit promotion

`/proc save` writes two reviewable project files:

```text
.pi/procedures/<name>.json
.pi/procedures/<name>.proc.js
```

The manifest records title, description, default goal, source filename, allowed tools, and creation time. Name collisions receive a numeric suffix instead of overwriting an existing procedure.

Saved procedures remain source-controlled only if you choose to commit them. Every `/proc run` still asks for tool approval.

## Visibility and data boundaries

Each run records bounded:

- phase and status;
- task prompts and results in the local snapshot/monitor;
- effective models and thinking levels;
- current task/tool activity;
- attempts, errors, and recent tool history;
- token/cache/cost/turn usage;
- artifacts and final result;
- generated source and allowed tools;
- up to 500 recent events.

`procedure_status` is intentionally metadata-first. It can list runs or inspect task status, models, activity, usage, and errors, but excludes full prompts and results and caps output at 50 KiB. Full local detail remains available in `/monitor` and the private run snapshot.

## Safety model

### Orchestration isolation

The JavaScript body runs in a worker thread and a `node:vm` context with dynamic string/wasm code generation disabled. The VM receives only a frozen `$` API and frozen JSON input. It has no direct filesystem, shell, network, module, or process access.

Node's VM is defense in depth, not a formal hostile-code security boundary. Source review remains mandatory.

### Child-agent confinement

- Child sessions do not recursively load extensions, skills, or prompt templates.
- Read/find/grep/list/edit/write paths are confined to the trusted project after symlink resolution.
- Mutations to `.git` are rejected.
- Child tools are limited to the launch-approved union recorded by the procedure.
- `bash` is not sandboxed; use it only for narrow verification after explicit approval.
- Credentials are transferred through runtime auth facilities and never included in source, author prompts, or saved manifests.

### Bounds

| Resource                    |               Bound |
| --------------------------- | ------------------: |
| Agent calls                 |          64 per run |
| Concurrent agents           |                   4 |
| Run duration                |             4 hours |
| Default task timeout        |          20 minutes |
| Maximum task timeout        |              1 hour |
| Read-only retries           |                   2 |
| Mutation/shell retries      |                   0 |
| Artifacts                   |                  30 |
| Artifact/result/task output |         64 KiB each |
| Retained events             |                 500 |
| Sleep                       | 60 seconds per call |

## Recommended patterns

### Parallel scouts, sequential synthesis

```js
const evidence = await Promise.all([
  $.agent("api", "Return API constraints only.", { tools: ["read", "grep"] }),
  $.agent("tests", "Return test gaps only.", { tools: ["read", "grep"] }),
]);
const plan = await $.agent("planner", `Synthesize:\n${evidence.map((x) => x.text).join("\n")}`, {
  tools: ["read"],
  thinking: "high",
});
```

### Bounded repair

```js
let verification = await $.agent("verify-1", "Run the focused checks.", {
  tools: ["read", "bash"],
});
if (verification.text.includes("FAIL")) {
  await $.agent("repair-once", `Repair this failure:\n${verification.text}`, {
    tools: ["read", "edit", "write"],
  });
  verification = await $.agent("verify-2", "Rerun the focused checks.", {
    tools: ["read", "bash"],
  });
}
return { verification: verification.text };
```

Use an explicit small bound; never ask a model-controlled loop to “continue until good.”

### Human decision boundary

```js
const plan = await $.agent("planner", "Produce a concrete plan and changed-file list.", {
  tools: ["read", "grep", "find", "ls"],
});
if (!(await $.approval("Apply this plan?", plan.text.slice(0, 6000)))) {
  return { status: "declined", plan: plan.text };
}
```

## Troubleshooting

### “Trust this project before creating or running procedures”

Procedures can launch agents with file/shell tools, so Pi project trust is required. Review and trust the repository first.

### “No approved procedure model is available”

Authenticate and enable at least one model from the four-model policy. If the Pi session uses scoped models, include at least one approved reference in that scope.

### A generated model reference fails

The model must exactly match the live catalog shown to the author. Availability can also change between authoring and execution; regenerate or edit the source to a currently available reference.

### The run is waiting indefinitely

Open `/monitor`. It may be paused or waiting for `$.approval()`. Use `a`/`d`, or `/proc approve <run-id>` and `/proc deny <run-id>`.

### The run is marked interrupted after `/reload`

Version 1 does not resume active workers across reload/process exit. Start a new run from the saved procedure or original goal.

### A read-only task did not retry

Retries occur only up to the requested bound and only for tasks without `edit`, `write`, or `bash`. Side-effect tasks never retry automatically.

### Source validation rejects a word in a comment/string

Validation conservatively scans source for forbidden host-access patterns. Rephrase/remove the pattern; procedures should not need those APIs even as examples.

## Manual QA and design rationale

- [`AUTHORING.md`](AUTHORING.md) — complete guide injected into every author session
- [`QA.md`](QA.md) — destructive end-to-end test prompt and monitor checklist
- [`RESEARCH.md`](RESEARCH.md) — evidence and tradeoffs behind the primitive

Run QA only in a disposable branch/repository because the scenario intentionally creates and repairs files.

## Development

```bash
pnpm --filter pi-procedures check
pnpm --filter pi-procedures format
```

Smoke-test loading after changes:

```bash
pi -e ./extensions/procedures/index.ts --list-models
```

Then run `/reload` in Pi. Tests cover author catalogs/model policy, worker isolation, unawaited operations, concurrency, retries, tool declarations, path/symlink confinement, ephemeral persistence, and saved-definition allocation.
