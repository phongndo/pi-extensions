---
name: research
description: Investigate a question against high-trust primary sources and capture the findings as a Markdown file in the repo. Use when the user wants a topic researched, docs or API facts gathered, or reading legwork delegated.
---

Investigate the question against **primary sources** and write the findings to a single cited Markdown file in the repo.

If you can dispatch a sub-agent, do the research there so this session can keep working. The research agent must complete the reading itself and must not spawn further agents. If you cannot dispatch a sub-agent, or you already are one, do the research in this session.

Prefer available web tools (`search`, `fetch`, `map`, `crawl`, `extract`) to reach primary sources. Follow every claim back to the source that owns it: official docs, source code, specs, first-party APIs, not a secondary write-up of them.

1. Investigate the question against those primary sources.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.
