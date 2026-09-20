# Personalizing Pi instructions for conversational development

Research date: **2026-09-20**. Subsequent status: **approved and installed on Mac through chezmoi**.

The authoritative source is now `~/nix-config/chezmoi/dot_pi/agent/AGENTS.md`, applied as a regular file to `~/.pi/agent/AGENTS.md`. The linked draft is a review snapshot. Pre-installation statements below record the research stage; Linux deployment and behavioral evaluation have not been performed.

Proposed instructions: [`../drafts/pi-global-AGENTS.md`](../drafts/pi-global-AGENTS.md).

Companion: [model-behavior research and Pi configuration considerations](gpt-6-astra-pi-instructions.md).

**Revision after user review:** the current draft is shorter and covers learning as well as coding, with a small Nix-environment section. The detailed retry, waiting, and coordination rules discussed below describe earlier candidates and their rationale, not requirements retained in the current file.

## Recommendation

The strongest personalization is **thinking partner during exploration, dependable implementer after authorization**.

The history supports neither an agent that turns every question into edits nor an agent that asks permission for every step. The important boundary is between **developing an idea together** and **carrying out an accepted action**. Once implementation is authorized, preserving the agreed scope means finishing it, not reducing it to a convenient first slice. [H1][H2][H4][H5][H11]

The revised draft puts this conversational contract first. Bounded, risk-based verification remains important, but it serves that contract rather than defining the whole relationship.

This is a best-supported candidate for this user's workflow, **not a behaviorally proven optimum**.

## What was examined

The two standard Pi session stores were indexed locally and over the existing SSH connection. Remote examination was read-only. No session material was sent to web search or external research services.

| Coverage                                                      |   Mac | Linux | Total |
| ------------------------------------------------------------- | ----: | ----: | ----: |
| Session JSONL files indexed                                   | 2,919 |   120 | 3,039 |
| User-role records before filtering                            | 8,119 |   660 | 8,779 |
| User-role records after heuristic filtering and deduplication | 7,209 |   660 | 7,869 |

The files covered approximately **2.85 GB**, with session start dates spanning **June 26–September 20, 2026** on Mac and **August 26–September 19, 2026** on Linux. The filter removed 729 installer sessions, 82 obvious delegated/template sessions, and the current research session; nine inherited user entries were deduplicated. The remaining index covered **2,227 sessions**. [M1]

Method:

1. Extract session metadata, user text, and question-tool exchanges. Exclude reasoning blocks, images, and general tool-result bodies from the index; apply basic secret redaction.
2. Search for conversational transitions, corrections, explanation preferences, scope boundaries, testing requests, and completion expectations.
3. Inspect user sequences and selected surrounding assistant excerpts from **14 sessions**, split evenly across the machines. Give explicit corrections and repeated request → discussion → authorization sequences more weight than keyword frequencies.
4. Translate those observations into general working preferences. Keep transcripts, precise private locators, and the analysis index outside the repository. This report contains aggregate methodology and paraphrased findings, not transcript quotations. [M1][H1–H14]

### Limits

- **Indexing is not reading every conversation end to end.** Contextual review was purposive and concentrated on informative examples.
- A user-role entry is not guaranteed human-authored. Embedded skills, pasted proposals, delegated instructions, and templates remain after heuristic filtering. Counts are corpus inventory, not counts of independent human preferences.
- Forks and branches complicate chronology. Preceding context was traced through parent entries; following excerpts and user sequences were inspected from file order. Not every branch was reconstructed into a complete active transcript.
- Long text was sometimes truncated: 13 user entries exceeded the index's 20,000-character limit; contextual extracts also have length limits. No claim depends on having read omitted text.
- Sources span projects, models, providers, and changing configurations. They support collaboration preferences, not causal attribution to one model, skill, or reasoning level.
- No failure was reproduced and no behavioral comparison of the new instructions was run. [M1]

## Findings and their instruction consequences

### 1. Discussion needs its own action boundary

**Strong evidence.** Multiple conversations begin with discussion or design requests, refine the proposed behavior over several turns, and only later authorize implementation. One direct correction followed an assistant starting scratch experiments during a discussion of next steps; leaving production source and public state untouched did not make that transition acceptable. A separate setup conversation explicitly emphasized discussion before installation. A recent session combines authorization to publish completed work with a request to discuss what comes next: permission applies to particular actions, not indiscriminately to the rest of the conversation. [H1][H2][H11][H14]

**Draft consequence:** during exploration, investigate read-only and produce requested research/design artifacts. Agree before implementation, including temporary prototypes and state-changing experiments.

**Important balance:** no special phrase is required. An ordinary action request, or clear acceptance of a specifically proposed action, authorizes it. A tentative possibility or approval of a concept is not equivalent to approval of every implementation step. This prevents both premature action and ritual confirmation.

### 2. Prefer incremental design and understandable explanations

**Strong evidence.** The user repeatedly narrows an overlarge proposal, works through the next command or behavior, asks for simple explanations, and requests concrete or visual representations. The main conversation is also a place to learn while work develops—not merely an execution queue. [H2][H4][H10][H12][H13]

**Draft consequence:** start with a recommendation, its reason, and the important tradeoff. Resolve the next meaningful decision. Explain the behavior or mental model before terminology; use short sections and small examples or diagrams when they improve understanding.

**Avoid overcorrection:** this does not mean universally tiny answers, mandatory diagrams, a full HTML artifact for every question, or permanently separating discussion from implementation into different agents. The orchestration conversation specifically corrects an interpretation that removes building from the main chat. [H4]

### 3. Be an honest collaborator and preserve decisions

**Strong evidence for the underlying preferences.** There are explicit requests to challenge the user's assumptions, corrections when analogies become literal technology choices, and frustration when an accepted interface decision is later treated as unsettled or replaced. [H2][H3][H9]

**Draft consequence:** challenge an idea with reasons and an alternative, not reflexive agreement. Use other projects to identify useful properties rather than copying their architecture. Distinguish proposed, accepted, and implemented behavior, and carry corrections forward.

Keeping an authorized task alive through side questions is a proposed operational application: answer the question and retain the task unless the user changes direction. It should be evaluated rather than treated as permission to ignore a pause or correction. [H4][H12][H13]

### 4. Once authorized, complete the whole agreed outcome

**Strong evidence.** A testing-framework conversation contains repeated checks on whether the entire plan was implemented, followed by requests for the missing remainder. Other conversations move directly from an agreed design into implementation and verification, with publishing as a separately requested action. [H2][H5][H9][H10]

**Draft consequence:** routine implementation decisions do not need repeated approval. Completion includes necessary integration and proportionate checks. If a requested part is blocked or needs a new scope decision, say so; do not present partial work as the finished plan.

The publication pattern supports a default of explicit authorization for commits and pushes, but **not** asking again when the original request already includes them. Some history explicitly combines implementation and publication. [H6][H8]

### 5. Simplicity means a coherent product, not the fewest files or tools

**Strong evidence.** Recurring concerns include duplicated public concepts, unclear ownership, speculative infrastructure, excessive documentation, and unnecessary machinery around a small workspace. Conversely, a tool-design discussion favors separate simple operations over one confusing combined interface. [H3][H6][H7][H8][H9][H10]

**Draft consequence:** favor clear ownership, one source of truth, expressive interfaces, and the smallest coherent implementation of the current requirement. Keep documentation functional and authoritative instead of accumulating overlapping plans and reports.

**Do not globalize project-local constraints.** A particular repository's documentation count is not a universal cap. Neither is a preferred language, dependency choice, extension architecture, or toolchain. A workspace's need for lightweight checks does not imply its hosted compiler should have weak testing. [H6][H7]

### 6. Preserve strong testing; remove redundant process

**Strong evidence.** The user explicitly wants tests and benchmarks that expose real defects, memory/lifetime errors, undefined behavior, and regressions. Deterministic testing and meaningful performance evidence recur. In contrast, objections target orchestration and checks disproportionate to the changed layer, and speculative improvement cycles with little new information. [H5][H6][H7][H8][H10]

One especially useful counterexample: after criticizing an overbuilt development workspace, the user still asks for platform checks. The preference is not absence of verification; it is verification appropriate to that workspace. [H6]

**Draft consequence:** keep meaningful regression tests and project requirements, start with affected checks, broaden for concrete risk, and reuse valid results. Performance-sensitive changes warrant relevant evidence, not a universal benchmark campaign. Stop retries that no longer produce evidence; report blockers honestly.

The two-stalled-attempt checkpoint remains a heuristic from the [earlier model-behavior research](gpt-6-astra-pi-instructions.md), **not a testing limit inferred from personal history**.

### 7. Let actual use motivate the next improvement

**Moderate, direct evidence.** In an extension discussion, the user questions whether continued checks and improvements are useful compared with using the tool for a few days and returning with observed problems. This supports a stopping rule, but not a ban on requested testing or further work. [H8]

**Draft consequence:** once the agreed outcome and required checks are satisfied, deliver. Further work needs a concrete defect or a new request. Do not end every successful task by generating another speculative improvement program.

## What changed from the generic draft

- Conversational intent, authorization, and incremental explanation now come first.
- Read-only discussion is distinguished from implementation even when proposed changes are temporary.
- Clear action requests still lead to autonomous follow-through; there is no universal approval gate.
- Preserving settled decisions and answering side questions without forgetting the task are explicit.
- Simplicity includes interface clarity and documentation restraint, not just smaller diffs.
- Existing risk-based verification, stalled-loop handling, sensible waiting, conditional delegation, and evidence-based completion remain.
- Model-specific complaints, private history, citations, and evaluation detail stay out of the always-loaded file.

The file follows the repository's [writing-for-agents guidance](../../skills/writing-for-agents/SKILL.md): co-locate related rules, keep completion conditions checkable, and reserve always-loaded space for behavior that matters across tasks. [P3]

## Adoption and a lightweight check

**Nothing has been installed.** The existing diagnosing-bugs skill also remains unchanged; its broad trigger and persistence requirements still deserve the source-level review described in the [earlier report](gpt-6-astra-pi-instructions.md).

After approval, try the draft in a few ordinary fresh sessions before inventing more instructions or an evaluation framework. Useful cases are:

| Situation                                              | Desired behavior                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Discuss an alternative, then tentatively like it       | Explain and refine; no unrequested code changes or prototype execution              |
| Accept a clearly proposed implementation               | Implement without asking for the same approval again                                |
| Request publication of completed work, then discussion | Perform the authorized publication; discuss the next change without implementing it |
| Ask a learning question during authorized work         | Answer clearly and preserve the remaining task; honor any explicit pause            |
| Request a complete multi-part change                   | Finish all agreed parts or identify exactly what is blocked                         |
| Reach passing, relevant checks                         | Deliver without redundant suites or a fresh speculative improvement round           |
| Encounter an environmental blocker                     | Diagnose proportionately and report what is missing rather than loop                |

Look for fewer intent corrections, forgotten decisions, incomplete deliveries, and redundant checks **without losing correctness**. Compare under similar project instructions, skills, provider, and reasoning effort. Static review of the prose is not evidence that these outcomes will occur.

Install only after review, using the active Pi agent directory and preserving any existing context file. Pi context loading remains additive; this global file cannot silently cancel conflicting project or skill instructions. See the [Pi-specific installation notes](gpt-6-astra-pi-instructions.md). [P1]

## Source register

Session references are intentionally privacy-preserving. Each H label maps in a **private evidence index outside the repository** to a host, original session path, session ID, and selected entry IDs/line numbers. The private index and extracts are temporary research artifacts, not permanent public citations. They were not installed as agent memory.

- **[M1] Private session inventory and analysis artifacts.** Generated from the two Pi stores; includes inventory, filtering counts, scripts, and contextual extracts. Session parsing was informed by installed Pi 0.86.0 session documentation. [P2]
- **[H1] Linux contribution discussion.** Action-boundary correction after temporary experiments.
- **[H2] Mac command-interface design.** Incremental design, explicit implementation transition, settled decisions, and publication boundary.
- **[H3] Linux configuration design.** Simplicity and correction of an overly literal analogy.
- **[H4] Mac orchestration design.** Main chat as both a learning/design space and a builder.
- **[H5] Linux test/benchmark framework.** Meaningful testing and repeated requests to complete the agreed plan.
- **[H6] Linux development-workspace setup.** Documentation and infrastructure restraint, followed by requests for useful platform verification.
- **[H7] Mac documentation and QA redesign.** Minimal authoritative docs together with stronger defect-finding tests.
- **[H8] Mac context-tool discussion.** Real-use feedback, simple separate operations, and explicit action requests.
- **[H9] Mac component-architecture discussion.** Honest challenge, architecture simplicity, and implementation follow-through.
- **[H10] Mac ownership-boundary refactor.** Scoped design, before/after explanation, authorization, and relevant regression/performance evidence. Structured prompts are used as task-boundary evidence, not assumed spontaneous prose.
- **[H11] Mac tool-installation discussion.** Explicit exploration before installation.
- **[H12] Linux extensibility/configuration discussion.** Simple visual explanations, temporary teaching artifacts, and implementation transitions.
- **[H13] Linux contribution walkthrough.** Incremental learning interleaved with engineering work and publishing questions.
- **[H14] Linux extension-state review.** A recent mixed request: publish completed work, then return to discussion; also distinguishes architecture from measured performance.
- **[P1] Installed Pi 0.86.0 `README.md`.** Context-file discovery and additive loading, read during the companion research.
- **[P2] Installed Pi 0.86.0 `docs/sessions.md` and `docs/session-format.md`.** Standard storage and JSONL entry/parent structure, read completely during this audit.
- **[P3] [`skills/writing-for-agents/SKILL.md`](../../skills/writing-for-agents/SKILL.md).** Instruction-writing guidance, read completely.
