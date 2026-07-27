# Research policy

Load this reference only for deep, broad, high-stakes, or conflicting-source tasks.

## Intent and mode

Classify the task before searching:

- **Navigation:** locate a known page. Use `web_map` or one search; no deep workflow.
- **Verification:** establish one claim. Use quick mode and a primary source.
- **Comparison:** apply the same criteria to several entities. Use standard mode and a facet per criterion rather than per source.
- **Temporal:** determine what is true now or during a specified interval. Require dates and use news/date filters only where relevant.
- **Obscure multi-hop:** discover an entity through indirect attributes. Use deep mode, preserve candidate hypotheses, and search distinguishing attributes.
- **Broad enumeration:** find many independent entities. Use broad mode; partition entities or regions without overlap.
- **Synthesis:** explain a field or controversy. Require source diversity and preserve disagreements.

Ask one clarification only when ambiguity would materially change the search space or answer criteria. Otherwise state a reasonable interpretation.

## Query construction

A good query has one retrieval objective and a few discriminative terms. Prefer a sequence of different query functions over paraphrases:

1. **Landscape query:** establish vocabulary and candidate sources.
2. **Primary-record query:** target an official domain, title, filing, paper, standard, or dataset.
3. **Disambiguation query:** combine an entity with a unique attribute, date, identifier, or quoted phrase.
4. **Contradiction query:** search the competing claim, correction, retraction, or later update.
5. **Verification query:** target the exact fact once a candidate answer is known.

Use search operators only when they narrow the intended corpus. Avoid long natural-language questions containing every constraint; search engines often drop terms. Split entangled constraints and intersect candidates through reasoning.

## Candidate selection

Before fetching, score candidates qualitatively:

- Relevance: does the result address the exact criterion?
- Authority: is it an original record or recognized expert source?
- Freshness: is it current enough for the criterion?
- Independence: does it add a new organization or evidence chain?
- Accessibility: can the actual supporting page be fetched and cited?

Fetch the highest expected-evidence candidates, not simply positions 1–3. Skip mirrors, scraped copies, SEO summaries, and duplicate syndication when an original exists.

## Source tiers

Use the narrowest accurate ledger tier:

- `primary`: original paper, filing, transcript, dataset, decision, specification, or direct statement by the relevant actor
- `official`: first-party documentation or organizational page
- `government`: government record or statistical agency
- `scholarly`: peer-reviewed work or reputable preprint repository
- `reputable`: professionally edited reporting or established specialist publication
- `secondary`: useful analysis without primary authority
- `community`: forum, social post, wiki-like contribution, or user-generated material
- `unknown`: provenance cannot be established

A first-party source can establish what an organization says, but not necessarily that its disputed claim is objectively true. For consequential claims, combine a primary record with an independent source.

Independence is about evidence chains, not URL count. Two articles repeating the same press release are one evidentiary source.

## Evidence cards

Create one narrow claim per card. The excerpt must directly support that claim and should normally be one to three sentences. Do not:

- Treat a search snippet as evidence
- Store a whole page as an excerpt
- Combine multiple unsupported claims in one card
- Infer causality from correlation
- Upgrade an estimate or allegation into a fact
- Remove qualifiers, scope, or dates that change meaning

Use confidence to represent the match between claim and evidence, not general trust in the website:

- `0.9–1.0`: explicit direct support
- `0.7–0.89`: strong support with a small inference
- `0.5–0.69`: partial or qualified support
- below `0.5`: do not count toward criterion coverage

## Contradictions

When credible sources conflict:

1. Verify that they refer to the same entity, metric, period, and definition.
2. Prefer later corrections, original records, and sources with transparent methodology.
3. Record both evidence cards and an open contradiction.
4. Search specifically for reconciliation, correction, or definitional differences.
5. Resolve only when evidence justifies it; otherwise report the disagreement.

Never silently average incompatible numbers.

## Broad research and delegation

Delegate only independent units. A good worker brief specifies:

- One bounded facet or entity set
- Why it matters to the final answer
- Inclusion and exclusion boundaries
- Search and fetch budget
- Preferred source types
- Required evidence-card fields
- A requirement to return citations and unresolved gaps

The lead agent retains the answer criteria, deduplicates returned sources, verifies evidence, and performs final synthesis. Workers must return condensed findings rather than raw tool transcripts.

## Stopping policy

Stop when any condition holds:

- Every required criterion reaches its independent-source minimum, and no gap or contradiction remains.
- Two consecutive rounds add no evidence.
- Queries are becoming near-duplicates.
- The selected mode's budget is exhausted.
- Remaining information is inaccessible, unknowable, or outside scope.

Do not keep searching merely to spend the budget. Conversely, do not stop because the first plausible answer confirms the initial hypothesis.
