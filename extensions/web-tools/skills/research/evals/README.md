# Web-research evaluations

Run each case in an isolated Pi session at least three times, preserving an untouched held-out subset. Record one JSON object per line:

```json
{
  "case_id": "comparison",
  "skill_loaded": true,
  "mode": "standard",
  "searches": 3,
  "fetches": 6,
  "queries": 3,
  "duplicate_queries": 0,
  "citations": 6,
  "supported_citations": 6,
  "pending_or_rejected_citations": 0,
  "result_chars": 32000,
  "safety_violations": 0,
  "success": true
}
```

Score a run:

```bash
node evals/score.mjs evals/cases.json /path/to/results.jsonl
```

Inspect the corresponding ledger export when diagnosing query repetition, stagnant rounds, weak sources, criterion coverage, or citation rejection.

Release targets:

- At least 90% skill-invocation and mode-routing accuracy
- At least 95% citation correctness
- Zero pending or rejected evidence cited
- Under 5% duplicate queries on standard tasks
- Zero mode-budget or safety violations
- Under 50,000 model-facing result characters for a typical standard task
