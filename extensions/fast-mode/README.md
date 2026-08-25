# Pi Fast Mode

> A global, persistent `/fast` toggle for eligible OpenAI Codex models, with an unmistakable `ϟ` indicator in Pi's built-in footer.

Fast Mode adds `service_tier: "priority"` to supported `openai-codex` requests. It is intentionally tiny at the command surface and careful underneath: state is atomic, concurrent Pi processes coordinate through a recoverable lock, child runtimes inherit the policy, and unsupported providers or models are left untouched.

## At a glance

|                   |                                                                       |
| ----------------- | --------------------------------------------------------------------- |
| Command           | `/fast`                                                               |
| Scope             | Global across Pi sessions using the same agent directory              |
| Default           | Off                                                                   |
| Indicator         | `ϟ` before the eligible model ID in Pi's built-in TUI footer          |
| State             | `~/.pi/agent/fast-mode.json` by default                               |
| Eligible provider | `openai-codex`                                                        |
| Eligible models   | GPT-5.4, GPT-5.5, and GPT-5.6 variants using `openai-codex-responses` |

## Quick start

1. Select an eligible OpenAI Codex model in Pi.
2. Toggle priority service:

   ```text
   /fast
   ```

3. Look for the footer marker:

   ```text
   ϟ gpt-5.6-luna
   ```

4. Run `/fast` again to turn it off.

The command accepts no arguments. Pi reports the resulting global state after every successful toggle.

## What “Fast” means

When enabled, the extension transforms eligible provider payloads from:

```json
{
  "model": "gpt-5.6-luna"
}
```

to:

```json
{
  "model": "gpt-5.6-luna",
  "service_tier": "priority"
}
```

The upstream provider controls actual admission, latency, availability, and billing. The extension requests the priority tier; it does not promise a particular speedup. Priority service may have different pricing or account requirements, so verify the terms of the OpenAI/Codex account in use.

## Eligibility

Fast Mode applies only when all of these are true:

- Global Fast Mode is enabled.
- The model provider is `openai-codex`.
- The model API is `openai-codex-responses`.
- The model ID is `gpt-5.4`, `gpt-5.5`, or starts with `gpt-5.6`.

Everything else passes through unchanged. In particular, enabling Fast Mode does not modify requests to `xai`, `anthropic`, direct `openai`, or unrelated Codex models.

## Global state and multiple Pi processes

The toggle is global rather than session-local. Each eligible request rereads the persisted state, so another Pi process sees a change without needing its own toggle.

The state file is written atomically with private permissions. Toggle operations use a lock directory with process-instance ownership rather than a PID alone. The lock implementation:

- serializes concurrent toggles;
- distinguishes PID reuse where the platform exposes process start identity;
- reclaims abandoned local locks;
- applies a conservative lease before reclaiming foreign-host locks;
- times out rather than silently racing.

Default files:

```text
~/.pi/agent/fast-mode.json
~/.pi/agent/fast-mode.json.lock/
```

If Pi uses a custom agent directory, these paths move with it.

## Footer behavior

The `ϟ` marker is shown only when:

- Fast Mode is on;
- the currently selected model is eligible; and
- Pi is using its built-in TUI footer.

Custom extension footers are not modified. The decorator reuses space already reserved by the built-in footer so the line width remains stable.

## Child sessions and other extensions

Fast Mode decorates both provider lookup and the active model runtime. Isolated `AgentSession`s that transfer provider authentication into child runtimes inherit the global Fast Mode policy without recursively loading this extension. Eligible Codex requests made through those runtimes therefore follow the same global Fast Mode setting.

## Failure behavior

Fast Mode fails visibly rather than weakening request behavior:

- Invalid state JSON produces an error notification.
- A state write failure leaves no partial state file.
- Lock contention eventually reports a timeout.
- Failure to install a provider/runtime decorator restores the original methods.
- Session shutdown removes footer and provider decorators.

To recover from a manually corrupted state file, move it aside and reload Pi:

```bash
mv ~/.pi/agent/fast-mode.json ~/.pi/agent/fast-mode.json.bad
```

The missing-file default is off.

## Troubleshooting

### `/fast` is enabled but no `ϟ` appears

Check that the selected model uses provider `openai-codex`, API `openai-codex-responses`, and an eligible model ID. The marker is intentionally hidden for unsupported models and custom footers.

### A request does not appear faster

Priority service is a provider request, not a local accelerator. Account eligibility, provider load, model behavior, prompt size, and tool latency still apply.

### Another Pi window changed the setting

That is expected: the state is global. Run `/fast` once to toggle it back.

### Pi reports an invalid state file

Move or repair `~/.pi/agent/fast-mode.json`. A valid file is:

```json
{
  "version": 1,
  "enabled": false
}
```

## Development

From the repository root:

```bash
pnpm --filter pi-fast-mode check
pnpm --filter pi-fast-mode format
```

After editing the extension, run `/reload` in Pi. Tests cover payload eligibility, provider/runtime decoration, footer rendering, atomic persistence, concurrency, stale-lock recovery, and platform-sensitive process ownership.
