---
name: grilling
description: Grill the user about a plan, decision, or idea using the available interactive question mechanism. Use when the user wants to stress-test their thinking or uses a 'grill' trigger phrase.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet.

When an interactive question tool is available, ask through it and wait for the answers rather than printing interview questions in prose. Ask up to four related frontier decisions per round, within the tool's supported batch size. If the frontier is larger, choose the most foundational decisions; incorporate those answers and recompute the frontier before asking more.

For each tool question:

- Use a concise prompt and a short, stable identifier if the tool supports one.
- Offer concrete choices when possible. Mark the recommended option and give a brief rationale or tradeoff using the fields the tool supports.
- Use free-form input when the answer is genuinely open-ended; include a concise recommendation when useful.

If no interactive question tool is available, ask one compact numbered question at a time and wait for its answer.

Each round the user's answers reshape the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another unsettled question belongs to a _later_ round.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment, use the available tools or dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. A running exploration is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Use the same available question mechanism for final confirmation. Do not act until the user confirms you have reached a shared understanding.
