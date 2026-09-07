# Codex Fast mode: diagnosis and improvement plan

> Historical pre-implementation findings at `fa959e4`. The reproduction and recommendations below describe that revision. The implementation retains the original inline `ϟ` indicator at the user's request; detailed state is available through `/fast details`. For current behavior and remaining WebSocket limitations, see [Fast Mode's README](../extensions/fast-mode/README.md).

Researched 2026-09-07 against checkout `fa959e4`, installed Pi 0.85.1, OpenAI documentation, and OpenAI's Codex source. **Research only: no runtime behavior, model selection, reasoning level, or global setting was changed.** No authenticated provider requests or paid benchmarks were made.

## Bottom line

The missing lightning marker is not just cosmetic for the current model:

- The current session reports `openai-codex/gpt-6-astra`, with `xhigh` reasoning.
- The saved `~/.pi/agent/fast-mode.json` contains `{"version":1,"enabled":true}`.
- `supportsCodexFastMode()` recognizes only `gpt-5.4`, `gpt-5.5`, and the `gpt-5.6` family. Both the footer and payload policy use that predicate.
- Consequently, **the extension is globally on but does not request Fast mode for Astra**. It also hides the marker, leaving the user unable to distinguish off from unsupported.

Sources: observed shell session metadata and state file; [`policy.ts`](../extensions/fast-mode/policy.ts), [`footer.ts`](../extensions/fast-mode/footer.ts), [`index.ts`](../extensions/fast-mode/index.ts).

OpenAI now explicitly documents GPT-6 Astra Fast mode, where available, at **2.5× Standard credit consumption**. Account/model availability still needs to be distinguished from a locally enabled preference. [1][2][3]

**Recommendation:** fix Astra eligibility and add an explicit supported status display first. Then replace model-name guessing with capability metadata and add request-level diagnostics. Do not silently lower reasoning or switch models under `/fast`.

## Diagnosis and verification

### Reproducible failing check

Run from the repo root; it neither reads credentials nor changes settings:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { prefixFastModeModelLine } from './extensions/fast-mode/footer.ts';

const model = {
  id: 'gpt-6-astra',
  provider: 'openai-codex',
  api: 'openai-codex-responses',
};
const lines = ['', `stats    (openai-codex) ${model.id}`];
const rendered = prefixFastModeModelLine(lines, model, true);
console.log(rendered[1]);
assert.match(rendered[1], /[ϟ⚡]/, 'enabled Fast mode must be visible for Astra');
JS
```

Current output:

```text
stats    (openai-codex) gpt-6-astra
AssertionError: enabled Fast mode must be visible for Astra
```

Changing only the model to `gpt-5.5` produces `stats  (openai-codex) ϟ gpt-5.5`. Applying the actual payload policy with enabled state produces:

| Model         | Marker  | Resulting payload                               |
| ------------- | ------- | ----------------------------------------------- |
| `gpt-6-astra` | Absent  | `{"model":"gpt-6-astra"}`                       |
| `gpt-5.5`     | Present | `{"model":"gpt-5.5","service_tier":"priority"}` |

This establishes the stale eligibility predicate as a sufficient cause, independently of fonts, cached state, or terminal styling. It does **not** establish the backend's actual processing tier; another configuration could also affect routing.

### Real footer and loader check

A separate unattended probe loaded the extension through Pi 0.85.1's actual `loadExtensions()` loader, invoked its session lifecycle handlers, and rendered the actual `FooterComponent` with synthetic session data. The saved on-state was read, not modified. Results:

- The host footer prototype was decorated.
- GPT-5.5 showed `ϟ` at 120, 80, 60, and 40 columns.
- Astra showed no marker at all four widths.
- Shutdown restored the original footer renderer.

Thus a general Pi 0.85.1 footer incompatibility was **not** reproduced through the real loader. The 40-column GPT-5.5 line does consume the entire stats/model separator (`...(auto)ϟ gpt-5.5...`), another reason not to rely on borrowed padding for essential status.

Sources: installed Pi [footer implementation][P1] and [extension loader][P2]; local [`footer.ts`](../extensions/fast-mode/footer.ts).

### Test coverage gap

```text
node --test extensions/fast-mode/tests/fast-mode.test.ts
16 passed, 0 failed
```

The existing tests omit Astra and test the prefix helper on a hand-written string. The prototype test checks installation/restoration, not actual rendered output. Also, the extension's development dependencies pin Pi **0.82.1**, while the root and installed host use **0.85.1**. A direct native import combining the root host with the extension patches a different package instance; Pi's real loader aliases host packages and avoids that particular mismatch. Future integration tests must exercise the loader rather than mistake module duplication for a production rendering bug.

Sources: [`tests/fast-mode.test.ts`](../extensions/fast-mode/tests/fast-mode.test.ts), [`extensions/fast-mode/package.json`](../extensions/fast-mode/package.json), [`package.json`](../package.json), [Pi loader][P2].

`pnpm --filter pi-fast-mode check` could not run because `pnpm` is absent from this shell's PATH. The Node test suite above ran successfully; this is not a claim that formatting, lint, and typechecking passed.

## What upstream actually does

### Fast is a service tier, not reduced reasoning

OpenAI distinguishes Fast mode on a supported model from choosing the separate, faster and less-capable Codex-Spark model. Higher reasoning effort also takes longer and uses more tokens. These are separate controls, not interchangeable implementations of Fast mode. [1][2]

The current extension already preserves reasoning while adding `service_tier: "priority"`; retain that invariant. [`policy.ts`](../extensions/fast-mode/policy.ts)

### Keep `priority` on the Codex wire for now

Current Codex source maps `ServiceTier::Fast.request_value()` to **`"priority"`** and accepts both `"fast"` and `"priority"` when parsing a tier. OpenAI's public API guide also documents both spellings as equivalent for supported models. The existing wire value is therefore not the identified bug; changing it is not the first fix. [4][5]

Keep the products' billing distinct:

| Product/model                     | Documented Fast credit behavior                            |
| --------------------------------- | ---------------------------------------------------------- |
| ChatGPT/Codex GPT-6 Astra         | 2.5× Standard, where available                             |
| ChatGPT/Codex GPT-5.6 and GPT-5.5 | 2.5× Standard                                              |
| ChatGPT/Codex GPT-5.4             | 2× Standard                                                |
| Direct OpenAI API                 | Separate API token pricing, not ChatGPT credit multipliers |

OpenAI documents a 1.5× model-speed increase for Codex GPT-5.4/5.5/5.6. Do not extrapolate that number to Astra or total coding-task time. [1][3]

### Eligibility is metadata-driven upstream

Codex's `ModelPreset` and backend `ModelInfo` include `service_tiers`, `default_service_tier`, and the older `additional_speed_tiers`. `supports_fast_mode()` checks for a priority service tier or legacy `additional_speed_tiers: ["fast"]`. `service_tier_for_request()` filters out unsupported tiers. This is a stronger design than continually extending a model-name regex. [6]

**Pi constraint:** the inspected 0.85.1 `Model` interface has no service-tier capability fields. Its built-in Codex provider uses a generated catalog and does not expose a Codex-specific live `/models` refresh in that provider implementation. Dynamic capability support therefore requires an upstream Pi change or a deliberate extension-owned metadata adapter; it is not simply `ctx.model.service_tiers`. [P3][P4]

### Requested is not confirmed

OpenAI's public API documentation identifies the response object's `service_tier` as the tier used and documents possible downgrade to `default`. That is API evidence, not proof that every ChatGPT/Codex response reports identically. [5]

Pi's `after_provider_response` event exposes HTTP status and headers, not the streamed response body. In the inspected Codex implementation, response tier is consumed during pricing rather than exposed as a dedicated finalized assistant-message field. Its pricing resolver even substitutes the requested `priority` tier when a Codex response says `default`. Consequently, neither a success HTTP status nor Pi's displayed dollar estimate is reliable proof of priority admission. [P5][P6][P7]

The extension should initially say **“Fast requested”**, not “Fast confirmed.” Reliable confirmation requires preserving raw response-tier metadata in Pi's provider layer, with an explicit unknown state when the backend omits or ambiguously reports it.

## Recommended implementation, in order

These are proposals, not changes already made.

### 1. Make status unambiguous

Use Pi's documented `ctx.ui.setStatus("fast-mode", text)` instead of making a prototype patch the sole indicator. Suggested states:

| Situation                         | Display                                |
| --------------------------------- | -------------------------------------- |
| Preference off                    | `fast off`                             |
| On and locally eligible           | `⚡ fast on`                           |
| On but model unsupported          | `fast on · unavailable for this model` |
| Eligibility cannot be established | `fast on · support unknown`            |
| State cannot be read              | `fast error`                           |

Use text alongside the glyph so fonts cannot make the state unknowable. Standard `setStatus` uses Pi's extension-status row and is available in TUI and RPC. A custom footer must explicitly render `footerData.getExtensionStatuses()`; do not promise universal visibility under arbitrary custom footers. A widget is an optional fallback, not a reason to replace someone else's footer. [P5][P8][P9]

Keep preference separate from in-flight/last-request state: changing the setting does not alter a request already sent. If request diagnostics are added, show the last request's model and requested tier separately.

### 2. Add `/fast on`, `/fast off`, `/fast status`

Match Codex's documented command surface; keep bare `/fast` as the existing toggle for compatibility. [1]

- `on` and `off` should be idempotent; `status` must never write state.
- Report global preference, current-model eligibility and reason, next-request intent, and last observed request if known.
- Explain that “off” means this extension stops requesting priority; the existing policy leaves another caller's explicit priority field untouched.
- Keep the current global scope, atomic persistence, and concurrency protections rather than silently changing scope.

Sources for current behavior: [`index.ts`](../extensions/fast-mode/index.ts), [`policy.ts`](../extensions/fast-mode/policy.ts), [`state.ts`](../extensions/fast-mode/state.ts).

### 3. Fix Astra now; make capability handling maintainable next

Short term: add the exact documented `gpt-6-astra` model, guarded by the existing Codex provider/API checks. Treat that as a maintained fallback, not proof of this account's entitlement. Do not enable every future `gpt-*` model by regex. [1][2][6]

Long term: preserve upstream capability metadata in Pi and resolve eligibility through one shared policy used by both UI and requests. Distinguish verified unsupported from unknown. Cache discovery outside the per-request hot path; do not fetch a model catalog on every token or turn. Unknown models should remain unchanged and explain why.

**Migration caution:** the user's persisted preference is already on. Fixing Astra eligibility would start requesting the higher-consumption tier after reload. Make that consequence visible; this research did not activate it. [1][3]

### 4. Keep the display synchronized across Pi processes

Current UI state refreshes at startup, local toggles, and eligible request reads. There is no file watcher; model selection does not reload state. An idle window can therefore remain stale after another process toggles the global setting. [`index.ts`](../extensions/fast-mode/index.ts)

Proposed approach: retain authoritative reads for requests, add a session-scoped watcher on the **parent directory** (the file is replaced atomically), debounce reloads, and publish status updates. Provide a polling fallback if needed. Start resources only at `session_start`, dispose on shutdown/reload, and prevent an old asynchronous read from overwriting a newer result. Pi explicitly documents session-scoped background-resource cleanup. [P5]

### 5. Improve observability without regressing child runtimes

Keep a minimal local request record: model, requested tier, timestamp, optional observed response tier, and transport. Do **not** log prompts, tool payloads, authentication, or complete response headers by default.

Do not blindly replace the provider/runtime wrappers with only `before_provider_request`. That hook is public and useful for session requests, but extension handlers are not automatically loaded into isolated child runtimes. Also, Pi catches hook errors and continues with the prior payload; this differs from the current policy's request-failing state-read error behavior. Preserve or deliberately reconsider those semantics. Local tests already cover inherited provider policy and runtime refresh behavior. [`tests/fast-mode.test.ts`](../extensions/fast-mode/tests/fast-mode.test.ts), [P5][P10]

Longer term, prefer a public Pi request-policy/service-tier API covering host and child runtimes over private `registry.runtime` access and `onPayload` receiver mutation. Keep this architectural work separate from the immediate UI/eligibility repair.

### 6. Measure speed separately from the toggle

For an opt-in benchmark, hold model, reasoning, task, context, and transport constant; alternate Standard/Fast runs and compare median/p95 time to first output, model completion time, tool time, token usage, and actual billed consumption. Use a bounded budget and obtain approval before spending credits.

Pi's Codex implementation already supports WebSocket connection reuse, cached continuation, and SSE fallback; preserve those rather than replacing transport as part of the Fast toggle. OpenAI's latency guidance also recommends fewer generated tokens, fewer requests, parallel work, and stable cacheable prefixes. Those are separate performance levers, not evidence that Fast admission worked. [P6][7]

## Acceptance checklist for the eventual patch

- Astra receives `priority` when on; off and unsupported requests remain unchanged.
- Every reasoning level is preserved.
- On/off/unknown/error are distinguishable without relying on a glyph.
- `/fast status` is read-only; repeated `on`/`off` calls are idempotent.
- Actual Pi-loader + real-footer tests cover theme escapes, narrow widths, model changes, and reload cleanup.
- Two idle sessions converge after an external atomic state write; stale async reads cannot restore an old display.
- Existing child-runtime, provider-refresh, hook-composition, and state-lock tests stay green.
- Request intent is never mislabeled as confirmed backend admission or authoritative billing.
- Development dependencies/test matrix are aligned with the supported host version.

## Primary sources

Web sources were fetched and read; Codex source references below point at mutable `main` as inspected on the research date. Local Pi sources refer to the installed dependency used for verification, not a claim about all Pi versions.

[1]: https://developers.openai.com/codex/speed
[2]: https://developers.openai.com/codex/models
[3]: https://learn.chatgpt.com/docs/pricing#token-rates
[4]: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs#L524-L552
[5]: https://developers.openai.com/api/docs/guides/fast-mode
[6]: https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs#L905-L930
[7]: https://developers.openai.com/api/docs/guides/latency-optimization
[P1]: ../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js
[P2]: ../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js
[P3]: ../node_modules/@earendil-works/pi-ai/dist/types.d.ts
[P4]: ../node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js
[P5]: ../node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
[P6]: ../node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js
[P7]: ../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js
[P8]: ../node_modules/@earendil-works/pi-coding-agent/docs/tui.md
[P9]: ../node_modules/@earendil-works/pi-coding-agent/examples/extensions/custom-footer.ts
[P10]: ../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js
