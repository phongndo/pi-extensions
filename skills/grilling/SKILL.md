---
name: grilling
description: Grill the user about a plan, decision, or idea using the question tool. Use when the user wants to stress-test their thinking or uses a 'grill' trigger phrase.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet.

When the `question` tool is available, ask through it and wait for the answers. Never print interview questions or numbered question blocks in prose. Ask up to four related frontier decisions in one call. If the frontier is larger, choose the four most foundational decisions; incorporate those answers and recompute the frontier before asking more.

For each tool question:

- Use a short, stable `id` and a concise prompt.
- Offer concrete choices when possible. Mark the recommended option in its label and use its description for the brief rationale or tradeoff.
- Omit options only when the answer is genuinely free-form; include a concise recommendation in the question text when useful.

If the `question` tool is unavailable, ask one compact numbered question at a time and wait for its answer.

Each round the user's answers reshape the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another unsettled question belongs to a _later_ round.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment, use the available tools or dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. A running exploration is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Use the `question` tool for final confirmation. Do not act until the user confirms you have reached a shared understanding.
