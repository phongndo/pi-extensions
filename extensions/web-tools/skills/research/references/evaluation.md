# Evaluation guide

Evaluate retrieval, research control, evidence quality, and final answers separately. A better provider cannot repair a poor search policy, and a strong writer can hide weak retrieval.

## Test sets

Maintain a private held-out set alongside public benchmarks. Stratify tasks by:

- Current news and time-sensitive facts
- Official documentation and known-site navigation
- Obscure multi-hop facts
- Comparative research
- Broad enumeration
- Academic literature
- GitHub history
- Conflicting or corrected claims
- Negative tasks that should not invoke research

Useful public suites include BrowseComp for difficult discovery and DeepResearchBench for report and citation quality. Public scores may be contaminated; never tune only against public tasks.

## Retrieval metrics

For a frozen query set and fixed `k`, record:

- Evidence Recall@5 and Recall@10
- Reciprocal rank of the first evidence-bearing page
- Primary/authoritative-source rate
- Duplicate and syndication rate
- Freshness accuracy
- Invalid or unfetchable URL rate
- Domain diversity
- P50/P95 latency
- Credits per evidence-bearing result

Run provider comparisons with identical queries, dates, geographic settings, and downstream model.

## Trajectory metrics

Use ledger exports to measure:

- Correct mode selection
- Searches and fetches per successful task
- Duplicate-query rate
- New evidence per round
- Coverage gained per search
- Number of stagnant rounds before stopping
- Open gaps and contradictions at answer time
- Fraction of later query terms derived from prior evidence
- Tool-result characters entering model context

Desired controller behavior:

- Simple tasks finish in quick mode.
- Most standard tasks finish within three rounds.
- No task continues for more than one round after a stop recommendation without a documented reason.
- Broad mode partitions work without duplicate facets.

## Evidence and citation metrics

Sample every claim and grade:

- Citation correctness: the cited page supports the exact claim.
- Citation completeness: substantive claims have citations.
- Source quality: the strongest reasonably available source was used.
- Source independence: corroborating citations do not share one evidence chain.
- Temporal validity: dates match the requested time frame.
- Entailment preservation: qualifiers and uncertainty remain intact.

Track rejected evidence cards. A high rejection rate indicates weak extraction or premature claim formation.

## End-to-end metrics

Grade task success along these axes:

- Factual accuracy
- Comprehensiveness
- Depth and useful synthesis
- Instruction following
- Readability
- Citation accuracy and completeness
- Explicit uncertainty
- Cost, latency, and context consumption

Report a Pareto frontier rather than one opaque score. Safety violations, fabricated citations, and unsupported confident claims are hard failures.

## Suggested release gates

- At least 90% correct research-mode routing
- Under 5% duplicate queries on standard tasks
- At least 95% citation correctness on audited factual claims
- Zero citations to pending or rejected evidence
- Zero research actions for negative/local-only tasks
- Typical standard task under 50,000 model-facing tool-result characters
- No safety violations
- No regression greater than 2 percentage points on held-out task success

Run each stochastic case at least three times. Preserve an untouched held-out subset whenever prompts, source scoring, or stopping thresholds change.
