# Research notes: code-driven orchestration

Research performed 2026-07-30. The implementation uses Claude Code dynamic workflows as inspiration, but deliberately keeps the primitive smaller and Pi-native.

## Findings

1. **Code should hold deterministic coordination; agents should hold judgement.** Anthropic distinguishes workflows (LLMs and tools on predefined code paths) from agents (the model dynamically controls its process). Procedures combine these: JavaScript owns fan-out, loops, branches, limits, and dataflow; native Pi agents solve each uncertain task. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

2. **Context efficiency is the main win.** Code can load only needed capabilities, filter intermediate data, and perform loops/conditions without another model turn for each operation. Anthropic reports one tool-discovery example falling from 150,000 to 2,000 tokens, while also warning that code execution adds sandboxing, resource, and monitoring costs. [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)

3. **Claude Code's key workflow mechanics are the right reference point.** A dynamic workflow is generated JavaScript that runs in the background; script variables hold intermediate results; the main session remains responsive; completed calls support partial progress; and the monitor exposes phases, agents, prompts, recent tools, results, token use, pause/resume, stop/restart, and size warnings. Claude Code retains the per-run script as a session artifact, but does **not** save it as a reusable command by default; that requires the explicit save action. Procedures follows the same distinction: ephemeral run source by default, `/proc save` for promotion. [Claude Code workflows](https://code.claude.com/docs/en/workflows) and [A harness for every task](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)

4. **Lifecycle correlation is required for truthful status.** Claude's Agent SDK exposes subagent start/stop, tool pre/post/failure, task completion, session IDs, agent IDs, tool-use IDs, and cancellation signals. Pi supplies equivalent native `AgentSession` events, so Procedures derives status from runtime events rather than agent self-report. [Claude Agent SDK hooks](https://platform.claude.com/docs/en/agent-sdk/hooks)

5. **Durability does not remove side-effect risk.** Temporal's guidance emphasizes idempotent activities, bounded retries, timeouts, explicit limit behavior, and monitoring failures, latency, backlog, history growth, resources, restarts, and retries. Procedures therefore retries read-only work only, caps every dimension, persists event snapshots, and marks interrupted runs explicitly. [Temporal pre-production testing](https://docs.temporal.io/best-practices/pre-production-testing)

6. **Observability should be hierarchical and privacy-aware.** OpenTelemetry models a top-level agent invocation with child model-call and tool-execution spans and records model, duration, tokens, and finish reason. Prompt/tool content is opt-in because it can be sensitive. Procedures mirrors that hierarchy (run → task → tool) and keeps external/event-bus status metadata-only. [OpenTelemetry GenAI observability](https://opentelemetry.io/blog/2026/genai-observability)

## Simpler than the inspiration

Procedures intentionally avoids a graph schema, dedicated agent-definition format, general package imports, and a second orchestration language. One reviewable JavaScript body plus six operations is enough:

```text
input · agent · phase · log · artifact · approval · sleep
```

Normal JavaScript provides sequence, parallelism, bounded loops, conditions, and error handling. Pi provides the model/auth runtime, isolated in-memory sessions, project context files, built-in tools, lifecycle events, abort signals, custom commands, custom entries, footer/widget UI, event bus, and TUI dashboard.

## Current tradeoffs

- Version 1 persists state but does not resume execution after process exit. Correctly replaying arbitrary JavaScript around partially completed side effects requires stable call-site identities and durable replay semantics; pretending otherwise would be unsafe.
- The four-agent concurrency limit favors understandable local behavior over Claude Code's much larger scale.
- Full shell confinement is not attempted. `bash` is an explicit, reviewed capability.
- Human checkpoints are supported through `/monitor`, including mid-procedure approval, rather than forcing each stage into a separate run.
