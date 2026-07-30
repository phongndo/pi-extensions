# Manual QA scenario

Run this in a disposable branch or repository. It creates `procedure-qa-shitty-app/`.

## Prompt

```text
/proc Create and execute a disposable end-to-end QA procedure for the Procedures extension itself. The procedure must build a deliberately shitty but runnable dependency-free Node.js URL-shortener app under ./procedure-qa-shitty-app, then independently review, repair, and verify it.

Exercise every orchestration feature:
1. Inspect the live model catalog provided to the procedure author. Create a model-allocation artifact explaining the model and thinking level selected for each role. Use at least two different available models when the catalog permits it; otherwise use meaningfully different supported thinking levels on the one available model. Use cheaper/faster settings for narrow scouts and stronger reasoning for architecture, implementation, adversarial review, and repair. Never invent a model or unsupported thinking level.
2. Start with two parallel read-only agents: one defines a minimal URL-shortener behavior/spec and one defines a security and test attack plan. Use focused prompts and low-cost model/reasoning choices.
3. Add an explicit approval checkpoint before any file mutation or shell command. Show the proposed files, model allocation, and safety boundary in the approval details.
4. After approval, have an implementation agent create the intentionally bad first version. It should have several realistic defects: weak input validation, collision-prone IDs, incorrect status codes, unsafe persistence assumptions, and inadequate tests. Keep it dependency-free so no network install is needed.
5. Run two independent reviewers in parallel using different roles/model choices: a security reviewer and a correctness/test reviewer. Save their compressed findings as an artifact.
6. Have one capable fixer repair all confirmed findings with edit/write tools. Do not retry mutation agents.
7. Use a verifier with bash to run the app's test command. If verification fails, allow exactly one bounded repair attempt and rerun once. No unbounded loops.
8. Finish with a fresh read-only adversarial review and return a small JSON result containing created files, defects found, fixes made, test result, final review, model allocation, and token usage summaries.
9. Use clear phases and logs throughout. Await every $. operation. Keep all work inside ./procedure-qa-shitty-app.
```

## What to verify

1. During source review, confirm generated `$.agent` calls use only exact model references shown in the live catalog and supported thinking values.
2. Launch it, then open `/monitor`.
3. Confirm parallel agents appear simultaneously and each task shows its effective model and thinking level.
4. Drill into a task and verify current tool activity, prompt, usage, and result visibility.
5. Confirm the run stops at the approval checkpoint. Press `a` in `/monitor` to approve.
6. Press `p` during a later phase and verify new scheduling pauses while an already-running agent can finish; press `p` again to resume.
7. Confirm mutation tasks are not retried, while read-only tasks can be.
8. Confirm artifacts, phases, recent events, token totals, final tests, and terminal status are visible.
9. Confirm the generated workflow is not added to `.pi/procedures/` automatically.
10. Promote it explicitly with `/proc save <run-id> shitty-app-qa`, verify the files appear under `.pi/procedures/`, then rerun it with `/proc run shitty-app-qa`.
11. Optionally start another run and press `x` to verify cancellation preserves completed edits and records a cancelled snapshot.
