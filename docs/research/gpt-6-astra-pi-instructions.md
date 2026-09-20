# GPT-6 Astra complaints and a bounded global Pi instruction set

Research date: **2026-09-20**. Subsequent status: **approved instructions installed on Mac through chezmoi**; see the [personalization report](pi-conversational-working-style.md) for the authoritative source. Pre-installation statements below describe the original research stage.

Proposed instructions: [`../drafts/pi-global-AGENTS.md`](../drafts/pi-global-AGENTS.md).

**Personalization update:** the current draft also incorporates a [private Mac/Linux session-history audit](pi-conversational-working-style.md). Subsequent user review simplified it into collaboration and learning preferences, with short coding and Nix-environment sections. Detailed retry and orchestration rules below describe earlier candidates, not necessarily the current file. This report retains the model-behavior evidence and Pi-specific caveats; neither document establishes behavioral efficacy.

## Decision and scope

The user selected **bounded, risk-based testing** and **draft for review**, rather than changing live Pi configuration. The proposed file is a starting point to evaluate, not a proven universal fix.

**Recommendation:** use a compact set of execution defaults: explicit scope, proportionate verification, evidence-driven retries, bounded coordination, and a checkable completion condition. Avoid a giant collection of complaint-specific prohibitions. OpenAI explicitly says older instructions that encourage exhaustive testing and extensive prerequisite reading can overconstrain Astra. [O1][O2]

This survey focuses on coding-agent behavior that matters in Pi. It cannot enumerate everyone's opinion or every model weakness. Search covered official guidance, GitHub issues, Hacker News, Reddit, practitioner accounts, and the OpenAI community forum. The synthesis uses **13 directly read external sources**, plus local Pi documentation and instructions. Search snippets were discovery aids, not evidence for substantive findings.

### How to interpret the evidence

- **Official behavior guidance:** strongest evidence that a tendency is recognized by the vendor; not an independently measured failure rate.
- **First-hand reports:** evidence of what someone experienced, not proof that every setup reproduces it. Reports often combine model behavior, prompts, reasoning effort, tools, and harness behavior.
- **Practitioner evaluation:** useful within the evaluator's workload, not a universal model ranking.
- This was a purposive, complaint-oriented English-language sample, not a representative sentiment survey. Some replies were collapsed or not loaded. Votes do not establish technical truth.
- The same polling investigation appears on both Reddit and GitHub; those are **one investigation**, not independent replications. Other commenters report similar symptoms, usually without equally detailed traces. [C6][C7]
- No public example was reproduced locally. The proposed instruction set has not yet undergone behavioral A/B testing.

## Findings that should shape the draft

| Failure pattern                                           | Evidence and confidence                                                                                                                                                                                                                                                                                                                                     | Proposed response                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Excessive testing and redundant full-suite runs**       | **Vendor-acknowledged tendency, recurring user reports.** OpenAI says small tasks can receive broader verification than necessary. HN users describe repeated 15-minute full suites; Reddit reports unrequested Git-integrity checks and escalation to a very expensive packaged build. Reported durations are not independently verified. [O1][O2][C1][C4] | Start with affected checks. Expand for concrete risk or project requirements. Reuse valid results. End when acceptance checks pass.                                                      |
| **Scope creep and overengineering**                       | **Recurring qualitative reports.** Users describe a quick script becoming a multi-file architecture, unrequested polishing, and adjacent work replacing the original request. [C1][C3][C5][C10]                                                                                                                                                             | Smallest coherent change; new abstractions and infrastructure require a present need; report unrelated improvements separately.                                                          |
| **Hesitation, unnecessary questions, and early stopping** | **Vendor-acknowledged tendency, first-hand corroboration.** OpenAI notes Astra may pause where users expect routine assumptions and follow-through. Users report partial delivery and excessive clarification. [O1][O2][C5][C10]                                                                                                                            | Authorize understood, reversible, in-scope work; ask only about consequential ambiguity; define the requested end state.                                                                 |
| **Conflicting instructions and invented requirements**    | **Vendor-acknowledged sensitivity; users also report apparent disregard.** OpenAI warns that skills and AGENTS.md can strongly influence Astra. Some users report continued testing despite explicit prohibitions. Neither “always follows instructions” nor “all failures are bad prompts” fits the evidence. [O1][O2][C4][C5]                             | Keep guidance lean and conditional. If a rule blocks work, identify its actual source. Preserve explicit constraints and act on corrections. Prompting is a mitigation, not enforcement. |
| **Tool and orchestration loops with no progress**         | **Detailed user telemetry plus separate qualitative reports.** One investigation reports 47 empty status polls, about 7.13 million parent input tokens, and roughly 68% of parent raw input spent on those polls. A separate forum report describes coordination loops even with workers present. [C6][C7][C8]                                              | Prefer blocking waits or notifications. Back off necessary polling. Avoid duplicate work and healthy-worker replacement merely because a wait timed out. Use subagents selectively.      |
| **High or unpredictable quota consumption**               | **Multiple user reports; cause and accounting unresolved.** Some expensive runs involved polling; others reportedly completed without repetitive orchestration. Cached input volume is not equivalent to billable uncached tokens or subscription allowance. [C6][C7]                                                                                       | Reduce unnecessary context and calls, but investigate provider/harness accounting separately. Do not promise an AGENTS.md will fix quota metering.                                       |
| **Unreadable generated code and opaque tool scripts**     | **Concrete examples in a practitioner account.** Armin Ronacher shows compressed tests, string-splicing edits, nested interpreter invocations, and code inconsistent with the host project. His explanation about training incentives is a hypothesis, not established fact. [C2]                                                                           | Prefer targeted edit tools, normal formatting, descriptive names, and direct commands. Readability applies to tests and helper scripts too.                                              |
| **Partial integration or false completion**               | **First-hand reports, not a measured prevalence estimate.** A detailed Codex issue reports proxy evidence being treated as task completion; another user describes a new class not connected to the existing flow. [C5][C10]                                                                                                                                | Verify the requested behavior at the relevant seam. Separate implementation from verification, and component checks from end-to-end evidence.                                            |
| **Verbose output and documentation churn**                | **Vendor-acknowledged writing tendency; community corroboration.** OpenAI notes detailed formatting and recurring phrases. Users complain about excessive prose, comments, and documents, though some replies also concern other models. [O1][C10]                                                                                                          | Brief outcome-oriented updates and final reports; comments for non-obvious intent; compact state only for long tasks.                                                                    |
| **Safety false positives and product-level blocks**       | **User report, trigger unconfirmed.** A forum author reports benign reliability reviews being suppressed by cybersecurity safeguards, including in fresh sessions. [C9]                                                                                                                                                                                     | Describe the legitimate task precisely and report genuine blocks. Do not add “ignore safety” instructions or claim prompt text can override provider controls.                           |

### Endless tests: the most defensible correction

OpenAI's own recommendation is unusually close to the user's concern:

> “Once those pass, broaden or repeat testing only when new changes, failures, or unresolved concerns justify it.” [O1]

This should become a decision rule, not a blanket ban on tests. A shared API change, authentication fix, migration, or concurrency bug may require integration, security, or repeated statistical checks. A prose edit generally does not require an application-wide test run. Required project checks remain required.

The draft adds three operational details beyond the vendor wording:

1. **Reuse results only while relevant state is unchanged.** A later code, dependency, or environment change can invalidate a previous pass.
2. **Separate productive iteration from a stalled loop.** After two consecutive attempts at the same failure yield no new evidence or measurable progress, reassess before doing more. A materially different, evidence-backed diagnostic can proceed; without one, report the blocker. **Two is a proposed heuristic, not an empirically optimal threshold.** It is not a two-test maximum.
3. **Make repetitions deliberate.** Flaky tests and statistical measurements need a finite repetition budget and explicit stopping criterion, rather than an accidental infinite retry loop.

The draft also preserves strong assertions and meaningful regression tests. “Fewer tests” is not permission to weaken checks or to declare unverified work successful.

### Over-persistence and under-persistence are both reported

Astra is not uniformly “too autonomous” or uniformly “too hesitant.” OpenAI discusses early stopping, while Ronacher describes an unattended 35-hour experiment he eventually stopped, and HN users describe repeated scope expansion. These can coexist across tasks and harnesses. [O1][O2][C1][C2]

The useful target is **bounded persistence**: continue toward the actual requested outcome, and stop expanding work once that outcome is established. A general “never give up” rule amplifies one failure mode; “always ask first” amplifies the other.

### Coordination needs harness-aware treatment

OpenAI says Astra may delegate less than desired and offers a prompt encouraging delegation. Conversely, user reports show costly delegation, polling, and coordination without useful progress. [O1][C6][C7][C8]

There is no contradiction to solve by ordering every task to use more agents. These reports describe different setups. The draft makes parallelism conditional on tool availability and useful independence, with bounded deliverables and ownership.

The Reddit investigator reports a Codex-specific timeout configuration workaround. It is **not a Pi setting**, and was not copied into this draft. Stock Pi deliberately has no built-in subagent system; installed extensions determine those capabilities. [C7][P1]

## Counterevidence and limits

It would be misleading to turn this survey into “Astra is bad at coding.” CodeRabbit reports **61.3% overall actionable bug coverage versus 59.0% for Sol**, and **57.1% versus 47.6%** on its harder cross-file subset. CodeRabbit calls these early, directional results and explicitly limits what they establish. The absolute gains are 2.3 and 9.5 percentage points, respectively—not those numbers as universal percentage improvements. [E1]

Critical users also acknowledge strong reasoning and occasional excellent results. Ronacher praises computer use and reverse engineering while criticizing software-engineering outcomes; the Codex reliability issue distinguishes peak capability from dependable delivery. [C2][C5]

**Not established by this survey:** a universal regression; deliberate model degradation; intentional token wasting; a single technical cause for quota consumption; an optimal reasoning effort for every task; or a guarantee that longer prompts improve behavior. Comments asserting these explanations were not promoted into findings.

## What matters in this Pi setup

### Observed local state

At research time, Pi's shell metadata reported:

```text
PI_PROVIDER=local-codex
PI_MODEL=gpt-6-astra
PI_REASONING_LEVEL=xhigh
```

These identify the **selected Pi configuration**, not proof of the upstream model a custom router actually serves. Pi explicitly documents that distinction. No inference was made about undocumented `local-codex` behavior. [P3]

No global `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `SYSTEM.md`, or `APPEND_SYSTEM.md` was found in the default agent directory. No alternate `PI_CODING_AGENT_DIR` was reported. Existing global configuration and skills were left unchanged.

### Global loading is additive

Installed Pi **0.86.0** documents the global path as `~/.pi/agent/AGENTS.md`. It also concatenates context files from ancestor directories and the current directory. An `AGENTS.override.md` replaces the ordinary context file **in its own directory**, not all other instruction files. `/reload` reloads context files. [P1]

Consequences:

- Global guidance cannot erase a repository's mandatory full-suite requirement or a conflicting higher-priority instruction.
- Audit the actual instruction stack when behavior persists; layering increasingly emphatic global text is not a reliable cure.
- Keep this research out of the global file. The draft contains behavior rules, not citations, debate, anecdotes, or model marketing.
- The draft's name, `docs/drafts/pi-global-AGENTS.md`, avoids making it an automatically loaded `AGENTS.md` while it is under review.

### A likely local source of tension: diagnosing-bugs

The current [`skills/diagnosing-bugs/SKILL.md`](../../skills/diagnosing-bugs/SKILL.md) contains these instructions:

- “Spend disproportionate effort here.”
- “Be aggressive. Be creative. Refuse to give up.”
- Require an already-run, deterministic, fast, red-capable command before Phase 2.
- Minimize until every remaining element is load-bearing.
- Generate 3–5 hypotheses before testing.
- Repeat original-scenario verification in later phases.

These are deliberate techniques for difficult diagnosis. However, its description also triggers on general reports of something broken, failing, or slow. Pi exposes skill names/descriptions first and loads the body when the task matches, so trigger breadth matters. [P2][L1]

**Inference:** this combination could turn a small fix into an expensive diagnostic project or conflict with the new stopping policy. It is not a proven cause of the user's observed loops. The initial survey did not analyze a failing session trace; the subsequent personal-history audit examined collaboration patterns, not the causal role of this skill in a reproduced testing loop.

**Suggested follow-up, not applied:** narrow the trigger to hard, unclear, or repeatedly failing bugs; allow a proportionate path for an obvious local defect; bound reproduction work; reuse still-valid results; and retain a clear blocker report when the necessary environment is unavailable. Update that source of guidance directly rather than relying on a global file to cancel it indirectly.

### Reasoning effort is a separate control

The current session uses `xhigh`. It is reasonable to compare lower effort on routine work while holding prompts, tasks, and harness constant; it is **not established** that lowering effort always improves cost, latency, or completion. OpenAI's migration guidance says to preserve an existing supported effective effort, rather than mandating a downgrade. [O1]

No reasoning settings were changed. The global draft does not pretend that prose can configure model parameters or provider accounting.

## Design choices in the proposed file

- **One verification policy**, rather than scattered “test everything,” “never test,” and “keep going” rules.
- **Action after clear authorization, without constant reconfirmation.** The personalized draft distinguishes discussion from implementation, including temporary prototypes, and preserves boundaries for destructive or external operations.
- **Scope discipline without a crude file-count or line-count cap.** A correct cross-file fix should remain possible.
- **Readable tooling and artifacts**, addressing a concrete critique without banning useful scripting.
- **Evidence-based completion**, so reducing test churn does not increase false confidence.
- **Conditional coordination**, because Pi extensions and other harnesses expose different capabilities.
- **No universal timeout, mandatory multi-agent review, exhaustive checklist, auto-installation, or safety bypass.** These would create fresh failure modes.

The draft follows the local writing-for-agents guidance: minimize always-loaded context, state completion conditions, co-locate related rules, and prefer actionable positive instructions. [L2]

## Validation before calling this “best”

The draft received a static review for contradictory rules, scope creep, applicability to Pi, and preservation of meaningful verification. That is **not** a behavioral evaluation. The [personalization report](pi-conversational-working-style.md) adds lightweight conversational trial cases; those can be tried during ordinary use without building an evaluation framework.

For a small practical comparison, use matched tasks from the same starting checkout in fresh sessions with and without this draft:

1. A prose-only edit.
2. An isolated bug with an existing focused regression test.
3. A small feature requiring wiring into an existing call path.
4. A shared-contract or security-sensitive change that genuinely needs broader checks.
5. A known environmental failure that should yield a blocker rather than endless retries.
6. A long-running command where repeated status polling adds no value.

Keep provider, reasoning effort, skills, and project instructions constant. Record accepted correctness, unrelated changes, repeated checks with unchanged inputs, human interventions, elapsed time, and available usage telemetry. Do not reduce results to raw token volume alone. Repeat ambiguous cases before attributing differences to the prompt.

Success means **less redundant work with equal or better accepted outcomes**, not merely fewer tool calls. Retain rules that change behavior and remove those that are redundant or cause missed work.

### Applying later, after approval

Review the draft and the debugging-skill conflict first. If accepted, copy its contents to `~/.pi/agent/AGENTS.md` (or the configured agent directory), preserving any file created since this survey, then run `/reload` or start a fresh session. Check the loaded context-file list. Installation has **not** been performed.

## Sources

All external sources below were read on 2026-09-20. Community reports are attributed observations, not vendor-confirmed root causes.

### Official guidance

- **[O1] OpenAI, [Model guidance / Using GPT-6 Astra](https://developers.openai.com/api/docs/guides/latest-model).** Read the Astra behavior and migration sections: initiative, instruction sensitivity, writing, delegation, verification, and reasoning effort. This is a mutable “latest model” URL; re-check before future reuse.
- **[O2] OpenAI Developers, [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).** Direct guidance on over-testing, excessive prerequisite reading, skill triggers, decision boundaries, and completion.

### First-hand criticism and incident reports

- **[C1] Hacker News, [AmazingTurtle's report and replies](https://news.ycombinator.com/item?id=49654479).** Repeated full suites, scope creep, and a long rebase task. Read this comment subtree; the larger discussion was sampled, not exhaustively read.
- **[C2] Armin Ronacher, [Astra for Coding: Why Are We Doing This Again?](https://lucumr.pocoo.org/2026/9/7/astra-why/), September 7.** First-person critique with generated-code examples and an unattended long-running experiment. Training-cause speculation remains speculation.
- **[C3] Reddit, [Finding GPT-6 Astra incredible but wildly over-engineered for coding?](https://www.reddit.com/r/codex/comments/1w936rv/finding_gpt6_astra_incredible_but_wildly/).** Read post and visible replies in the browser, including disagreement and suggestions for an architecture budget.
- **[C4] Reddit, [Astra does not follow instructions](https://www.reddit.com/r/codex/comments/1w9mlue/astra_does_not_follow_instructions/).** Read post and visible replies: unwanted tests, expensive builds, conflicting-instruction explanations, and contrary positive experiences.
- **[C5] GitHub, [openai/codex #42937](https://github.com/openai/codex/issues/42937), opened September 5.** Read the detailed issue body. Reports mixed Sol/Astra operational failures and separately labels ordinary ChatGPT examples; those non-Astra examples were not used as Astra evidence.
- **[C6] GitHub, [openai/codex #42987](https://github.com/openai/codex/issues/42987), opened September 5.** Read the issue body and loaded comments, including quota reports and tagorr's polling telemetry. Additional collapsed comments were not read.
- **[C7] Reddit, [I investigated why GPT-6 Astra burns quota so fast](https://www.reddit.com/r/codex/comments/1wa9c9d/i_investigated_why_gpt6_astra_burns_quota_so_fast/).** Read the post and visible replies in the browser. Same underlying investigation as tagorr's contribution in C6; reported configuration workaround not independently tested.
- **[C8] OpenAI Community, [Astra orchestration is broken](https://community.openai.com/t/astra-orchestration-is-broken-gets-stuck-in-loops-instead-of-delegating-to-workers/1398584), September 17.** Read opening report; it explicitly says the exact trigger has not been isolated. Later replies were not present in the retrieved body.
- **[C9] OpenAI Community, [False-positive cybersecurity blocks during Astra reliability audits in Codex](https://community.openai.com/t/false-positive-cybersecurity-blocks-during-astra-reliability-audits-in-codex/1395121), September 5.** Read opening report; cause unconfirmed. Later replies were not present in the retrieved body.
- **[C10] Reddit, [GPT-6 Astra is terrible for coding and doesn't even understand basic context](https://www.reddit.com/r/developersIndia/comments/1wizyxd/gpt_6_astra_is_terrible_for_coding_and_doesnt/).** Read post and visible replies in the browser. Used for reported missing integration, overengineering, and verbosity—not commenters' unsupported theories about motives or model degradation.

### Counterevidence

- **[E1] CodeRabbit, [GPT-6 Astra in code review: Gains, privacy, and cost](https://www.coderabbit.ai/blog/gpt-6-astra-code-review-evaluation), September 4.** First-party account of its own evaluation, not an independently reproduced benchmark. Used for its measured review results and stated limits, not as the authority on provider pricing or privacy policies.

### Local primary sources

- **[P1] Installed Pi 0.86.0 [`README.md`](/Users/dp/.local/share/mise/installs/pi/0.86.0/pi/README.md).** Read completely; context-file loading, overrides, `/reload`, reasoning controls, and absence of built-in subagents.
- **[P2] Installed Pi 0.86.0 [`docs/skills.md`](/Users/dp/.local/share/mise/installs/pi/0.86.0/pi/docs/skills.md).** Read completely; skill discovery and progressive loading.
- **[P3] Installed Pi 0.86.0 [`docs/environment-variables.md`](/Users/dp/.local/share/mise/installs/pi/0.86.0/pi/docs/environment-variables.md).** Read completely; selected-model metadata versus upstream routing, and configuration directory override.
- **[L1] [`skills/diagnosing-bugs/SKILL.md`](../../skills/diagnosing-bugs/SKILL.md).** Current local trigger and diagnosis requirements, read completely; not modified.
- **[L2] [`skills/writing-for-agents/SKILL.md`](../../skills/writing-for-agents/SKILL.md).** Local instruction-writing guidance, read completely.
