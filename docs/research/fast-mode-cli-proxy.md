# Fast mode through CLIProxyAPI

Investigated 2026-09-17 against this repository at `a4e2206`, Pi 0.85.1, and the locally installed CLIProxyAPI 7.3.3. The initial investigation changed no extension source or live configuration and sent no paid model requests.

**Implementation follow-up:** option A below is now implemented with a `fast-mode-proxies.json` opt-in file. See the [current setup instructions](../../extensions/fast-mode/README.md#codex-proxies-explicit-opt-in). Regression tests cover real Responses serialization, on/off, endpoint overrides, child inheritance, and discovery exclusion. The diagnosis and workaround observations below describe the original `a4e2206` baseline.

## Live A/B validation after implementation

On 2026-09-17, starting at 09:35 UTC, the user authorized a bounded live comparison through their real `local-codex` proxy. **Fast completed all four paired replies sooner.** Median completion time was **26.543s off versus 17.700s on**, a **1.500× ratio / 33.31% reduction in elapsed time** for this workload. First-text latency did not improve consistently.

| Metric (median of four runs per mode) | Fast off | Fast on |
| ------------------------------------- | -------- | ------- |
| Complete reply                        | 26.543s  | 17.700s |
| First text                            | 9.988s   | 12.251s |
| First-to-last text delivery interval  | 16.230s  | 5.106s  |

### Controls and method

- Actual endpoint: `http://127.0.0.1:8317/v1`; model `gpt-6-astra`; reasoning `xhigh`; Responses HTTP/SSE transport.
- Used Pi 0.85.1's `ModelRuntime` with the implemented Fast runtime/payload policy and the real configured proxy credential, resolved normally without printing or persisting it. A benchmark-local boolean controlled the policy; **the user's global preference stayed on and was never rewritten**.
- Eight sequential requests, four paired comparisons, with counterbalanced order: **off, on, on, off, off, on, on, off**. The first pair ran as a pilot; the remaining six resumed with the same session-affinity key. Each request had a 60-second deadline, no client retries, and a fixed short output task; all completed successfully. The proxy configuration also had `request-retry: 0` and no payload overrides.
- Exact same serialized request payload after removing `service_tier`, checked by a hash before every network call. Off omitted the field; on sent `priority`. No accumulated conversation, tool execution, model switching, reasoning-level changes, or transport changes.
- Same prompt and byte-identical output in all eight runs. Each response had 347 input tokens, zero cache-read tokens, and 606 output tokens after subtracting reported reasoning tokens. Actual reasoning-token counts varied even though the reasoning level was fixed.
- Same session-affinity key with the proxy's existing `fill-first` / session-affinity routing. Actual upstream account assignment was not independently verified or forcibly pinned.

Prompt:

```text
Output exactly 60 lines. Every line must be exactly: The quick brown fox jumps over the lazy dog. Do not include numbering, headings, commentary, blank lines, or code fences. Start with the first line immediately.
```

### Observations

All times are seconds measured with a monotonic clock from the start of each Pi stream request. First-to-last measures **client-observed text delivery**, not independently observed model compute time.

| Run | Pair | Fast | Complete | First text | First-to-last text | Reasoning tokens |
| --- | ---- | ---- | -------- | ---------- | ------------------ | ---------------- |
| 1   | 1    | off  | 25.283   | 8.609      | 16.432             | 172              |
| 2   | 1    | on   | 18.774   | 17.181     | 1.505              | 140              |
| 3   | 2    | on   | 13.841   | 6.965      | 6.861              | 119              |
| 4   | 2    | off  | 28.383   | 11.366     | 16.839             | 110              |
| 5   | 3    | off  | 27.803   | 13.369     | 14.288             | 144              |
| 6   | 3    | on   | 18.698   | 15.309     | 3.352              | 151              |
| 7   | 4    | on   | 16.703   | 9.193      | 7.465              | 115              |
| 8   | 4    | off  | 24.275   | 8.058      | 16.028             | 155              |

All eight requests returned HTTP 200, completed normally, and reported response tier `default`, despite the repeatable completion-time difference. Response-tier metadata was not used to infer admission. Fast-on delivery was sometimes bursty, so dividing tokens by the first-to-last text interval would overstate independently established model-generation speed; complete-reply latency is the primary comparison.

Reported aggregate usage: **2,776 input tokens; 5,954 output tokens including 1,106 reasoning tokens; zero cached input tokens**. These were real subscription requests. Actual billed credits were not measured.

**Interpretation:** the current proxy setup showed a meaningful Fast-on completion-time benefit on this controlled, small text-generation workload. This is not a guarantee for every response, a measured coding/tool-task speedup, or independent proof of backend admission/billing. Eight runs with one prompt and unverified upstream account assignment cannot establish broad performance guarantees. No further requests were made after the eight-run budget. Temporary benchmark code/state were removed after recording these non-secret results.

## Initial conclusion (before implementation)

The immediate problem was **the extension's provider/API restriction**, not a demonstrated inability of CLIProxyAPI to forward Fast-mode requests. The original extension supported only `openai-codex` + `openai-codex-responses`; this session uses `local-codex` + `openai-responses` through `http://127.0.0.1:8317/v1`. Its selected model is `gpt-6-astra`. These provider/model/endpoint values were read from session metadata and the non-secret portions of `~/.pi/agent/models.json`.

The recommended repair is explicit, opt-in proxy-route support in the extension, retaining `/fast` as the policy owner. A verified config-only workaround exists, but it bypasses the toggle. Neither approach can independently prove upstream Fast-mode admission or a speedup.

## Local diagnosis

Three ranked possibilities were investigated:

1. **Extension excludes the proxy route. Confirmed.** The same enabled payload hook adds `priority` for native Codex but not `local-codex`. The UI likewise reports the proxy as unavailable. `isCodexModel()` checks both the exact provider and API; runtime/provider decoration separately checks the provider ID. Sources: [`capabilities.ts`](../../extensions/fast-mode/capabilities.ts), [`policy.ts`](../../extensions/fast-mode/policy.ts), [`runtime.ts`](../../extensions/fast-mode/runtime.ts). This restriction is also explicit in the existing [extension README](../../extensions/fast-mode/README.md#child-runtimes-and-compatibility).
2. **Proxy removes priority. Not supported by the installed version's upstream source.** The Responses-to-Codex translator at tag `v7.3.3` retains `service_tier: "priority"`, but deletes other tier values. The inspected local proxy configuration contained no `payload` override/filter rules. This is source/config inspection, not a live capture of the proxy's outgoing request. [Translator source][translator]
3. **Backend accepts the request without trustworthy confirmation. Remains an upstream limitation.** Both an OpenAI contributor and CLIProxyAPI's maintainer explain that response-side `default`/`auto` is not reliable evidence that Fast mode was ignored. [OpenAI explanation][openai-issue], [proxy maintainer explanation][proxy-issue]

### Minimal red-capable reproduction

Run from the repository root with Node's TypeScript support (tested on Node 26.8.1). This executes the actual extension payload hook, without credentials, model calls, or persistent state changes:

```bash
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { model } from './extensions/fast-mode/tests/helpers.ts';
import { withFastPayload } from './extensions/fast-mode/policy.ts';

const selected = {
  ...model('gpt-6-astra'),
  provider: 'local-codex',
  api: 'openai-responses',
  baseUrl: 'http://127.0.0.1:8317/v1',
};
const options = withFastPayload(undefined, async () => true);
const payload = await options.onPayload({ model: selected.id }, selected);
assert.equal(payload.service_tier, 'priority');
JS
```

Observed: assertion fails with `actual: undefined`, `expected: 'priority'`. The native-provider control passed. This is a compatibility requirement the existing extension intentionally does not implement, rather than a failing promise in its current documented contract.

### Actual Pi serialization check

A temporary Python loopback capture server was used with the installed Pi executable, the real Fast extension, an isolated agent directory, fake credentials, offline startup, and synthetic SSE responses. The server never forwarded requests. Three separate Pi processes each emitted exactly one request:

| Case                                            | Captured request tier | Captured reasoning effort |
| ----------------------------------------------- | --------------------- | ------------------------- |
| Extension enabled, original proxy model config  | absent                | `xhigh`                   |
| Extension enabled, `samplingParams` workaround  | `priority`            | `xhigh`                   |
| Extension disabled, `samplingParams` workaround | `priority`            | `xhigh`                   |

All assertions passed. This verifies the extension's exclusion at the real serialized-request boundary and verifies the config workaround on Pi 0.85.1. It does **not** measure upstream admission, entitlement, billing, or latency. The temporary capture harness was removed after recording results.

## Resolution options

### A. Recommended: add opt-in proxy support to the extension

Implementation requirements from the investigation (now implemented; see setup link above):

- Explicitly configure/allow the intended `local-codex` + `openai-responses` route, preferably tied to the configured endpoint. Do not enable every OpenAI-compatible provider: those may have unrelated billing and capabilities.
- Update capability resolution, the payload guard, and both runtime/provider decorator selection. Changing only `isCodexModel()` would leave separate runtime gates in place. Sources: [capabilities](../../extensions/fast-mode/capabilities.ts), [policy](../../extensions/fast-mode/policy.ts), [runtime](../../extensions/fast-mode/runtime.ts).
- Reuse the existing global Fast preference and exact-model support policy. On eligible enabled requests, inject `service_tier: "priority"` without changing the model or reasoning. On disabled requests, preserve the existing contract of not overwriting another caller's explicit tier. [Existing policy](../../extensions/fast-mode/policy.ts)
- Keep official Codex capability discovery separate. A proxy credential is not an upstream account credential, and a rotating pool does not give Pi a stable single-account capability scope. Do not send proxy credentials to ChatGPT or relax the current official-endpoint discovery restriction. [Discovery implementation](../../extensions/fast-mode/capabilities.ts)
- Report **priority requested**, not backend admission confirmed. Preserve raw response-tier diagnostics with the upstream caveat below.
- Add regression coverage at the serialized-request boundary for on/off, unrelated providers, mismatched models, unchanged reasoning, and inherited child-runtime calls. The existing runtime tests show why a host-only event hook is not automatically equivalent to the full extension. [Runtime tests](../../extensions/fast-mode/tests/fast-mode.test.ts)

This preserves the user's account-pool routing and `/fast` workflow without requiring a proxy fork.

### B. Verified immediate workaround: Pi model `samplingParams`

Merge the following field into the existing `gpt-6-astra` model entry under `providers.local-codex.models` in `~/.pi/agent/models.json`; **keep the other model/provider/auth fields**:

```json
{
  "id": "gpt-6-astra",
  "samplingParams": {
    "service_tier": "priority"
  }
}
```

Pi documents `samplingParams` as a free-form request-body merge supported by `openai-responses`. Its model configuration reloads when opening `/model`; reselect the configured model, or restart Pi. This was also verified using the actual Pi 0.85.1 serializer. [Pi model documentation][pi-models]

**This is always-on for that model entry. `/fast off` will not disable it, and the existing extension still labels the proxy unsupported.** Remove the `service_tier` key and reload the model configuration to stop requesting it. It is a workaround for sending the request field, not a repair to the extension's toggle/status.

The same model-specific setting can be added separately to `gpt-5.4` if desired; only Astra was used in the serializer experiment.

### C. Proxy-side payload override

CLIProxyAPI documents `payload.override` rules for setting `service_tier: priority` on selected Codex models. For this installation's JSON configuration, an illustrative fragment to merge into `~/.cli-proxy-api/config.json` is:

```json
{
  "payload": {
    "override": [
      {
        "models": [{ "name": "gpt-6-astra", "protocol": "codex" }],
        "params": { "service_tier": "priority" }
      }
    ]
  }
}
```

This follows the installed version's [example configuration][proxy-config]. It was not applied or run locally. It affects every matching client request through that proxy, bypasses Pi's `/fast` preference, and is therefore less appropriate than option A for an interactive toggle. Do not replace an existing payload-rule collection wholesale.

## Important upstream facts

- **Send `priority`, not raw `fast`, on this route.** Codex's user-facing `service_tier = "fast"` configuration is distinct from the wire value. CLIProxyAPI 7.3.3's Responses translator explicitly preserves only `priority`. [Translator][translator], [OpenAI explanation][openai-issue]
- **A returned `service_tier: "default"` is not proof of failure.** OpenAI explains that the response field is not an end-to-end verification signal in ChatGPT-authenticated Codex mode. CLIProxyAPI likewise separates client-requested tier from upstream-reported tier in usage records. [OpenAI][openai-issue], [CLIProxyAPI][proxy-issue]
- **Do not treat forcing WebSockets as an established fix.** An issue reporter measured transport-dependent behavior, but the proxy maintainer disputed a WebSocket-only requirement and declined the proposed transport change. A later report also found no gain from forced WebSockets. Request pass-through is supported; guaranteed speedup on this user's accounts has not been demonstrated. [Transport discussion][transport-issue], [later investigation][proxy-issue]
- **Fast mode consumes more subscription credits.** OpenAI currently documents Astra at **2.5× Standard** where available and GPT-5.4 at **2×**. Account availability still matters. The API-looking connection from Pi to a local proxy does not itself turn pooled ChatGPT OAuth usage into OpenAI API-key billing. [OpenAI speed/pricing distinction][speed]

## Sources

[translator]: https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.3/internal/translator/codex/openai/responses/codex_openai-responses_request.go
[proxy-config]: https://github.com/router-for-me/CLIProxyAPI/blob/v7.3.3/config.example.yaml
[proxy-issue]: https://github.com/router-for-me/CLIProxyAPI/issues/5772#issuecomment-5647673503
[transport-issue]: https://github.com/router-for-me/CLIProxyAPI/issues/4586
[openai-issue]: https://github.com/openai/codex/issues/14204#issuecomment-4033184620
[speed]: https://learn.chatgpt.com/docs/agent-configuration/speed
[pi-models]: https://github.com/earendil-works/pi-mono/blob/v0.85.1/packages/coding-agent/docs/models.md

Pi documentation was read from the installed 0.85.1 distribution at `/home/z/.local/share/mise/installs/pi/0.85.1/pi/docs/models.md` and `docs/extensions.md`, including the `provider-payload.ts` example. CLIProxyAPI source/config examples were fetched from the matching `v7.3.3` tag. Public issue threads and OpenAI's speed page were read live, not inferred solely from search snippets.
