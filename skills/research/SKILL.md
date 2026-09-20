---
name: research
description: Research a question using primary sources. Use when the user delegates an investigation or asks for a cited research report.
---

Investigate the question against **primary sources**. Discover sources with web search, then read the selected pages; search snippets are leads, not evidence. Use broader crawling only when the question requires it.

Follow claims to the source that owns them: official docs, source code, specifications, or first-party accounts. Distinguish documented facts, attributed claims, and your inference. Report gaps rather than filling them from an older report.

If an available subagent can usefully handle the investigation, give it the question, scope, and output destination. It must read the sources itself and must not spawn further agents. Otherwise research in the current session.

## Deliver the findings

Answer the question with citations and material uncertainties. For a report, write one concise Markdown file containing the question, research date, supported findings, limitations, and primary-source links. Keep raw extracts, search logs, and intermediate notes out of the report.

Use the user's requested destination. Otherwise put a report in an OS temporary directory and give its path. Retain it in the repository only when the user requests that or the findings support an identified ongoing project decision; follow the repository's documentation policy. An existing research directory alone is not a reason to add a file.

When revisiting a retained report, recheck the relevant sources and replace superseded conclusions in place. Promote accepted operational guidance into its owning documentation; keep the report as evidence only while its rationale remains useful. Completion is a supported answer to the scoped question, with unresolved points explicit—not an exhaustive source collection.
