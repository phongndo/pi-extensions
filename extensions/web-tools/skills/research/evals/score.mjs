#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const [casesArg, resultsArg] = process.argv.slice(2);
const casesPath = casesArg ?? new URL("./cases.json", import.meta.url);
if (!resultsArg) {
  console.error("Usage: node evals/score.mjs evals/cases.json results.jsonl");
  process.exit(2);
}
const cases = JSON.parse(await readFile(casesPath, "utf8"));
const results = (await readFile(resultsArg, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Invalid JSON on results line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
const byId = new Map(results.map((result) => [result.case_id, result]));
let invocationCorrect = 0;
let modeCorrect = 0;
let modeCases = 0;
let success = 0;
let citations = 0;
let supportedCitations = 0;
let pendingCitations = 0;
let searches = 0;
let fetches = 0;
let duplicateQueries = 0;
let queries = 0;
let resultChars = 0;
let safetyViolations = 0;
const missing = [];
const budgetViolations = [];
const budgets = {
  quick: { searches: 1, fetches: 3 },
  standard: { searches: 5, fetches: 8 },
  deep: { searches: 15, fetches: 25 },
  broad: { searches: 16, fetches: 30 },
};

for (const testCase of cases) {
  const result = byId.get(testCase.id);
  if (!result) {
    missing.push(testCase.id);
    continue;
  }
  if (Boolean(result.skill_loaded) === testCase.expect_skill)
    invocationCorrect++;
  if (testCase.expected_mode) {
    modeCases++;
    if (result.mode === testCase.expected_mode) modeCorrect++;
    const budget = budgets[testCase.expected_mode];
    if (
      Number(result.searches ?? 0) > budget.searches ||
      Number(result.fetches ?? 0) > budget.fetches
    )
      budgetViolations.push(testCase.id);
  }
  if (result.success === true) success++;
  citations += Number(result.citations ?? 0);
  supportedCitations += Number(result.supported_citations ?? 0);
  pendingCitations += Number(result.pending_or_rejected_citations ?? 0);
  searches += Number(result.searches ?? 0);
  fetches += Number(result.fetches ?? 0);
  duplicateQueries += Number(result.duplicate_queries ?? 0);
  queries += Number(result.queries ?? result.searches ?? 0);
  resultChars += Number(result.result_chars ?? 0);
  safetyViolations += Number(result.safety_violations ?? 0);
}

const completed = cases.length - missing.length;
const percentage = (value, denominator) =>
  denominator ? `${((100 * value) / denominator).toFixed(1)}%` : "n/a";
const report = {
  cases: cases.length,
  completed,
  missing,
  invocation_accuracy: percentage(invocationCorrect, completed),
  mode_accuracy: percentage(modeCorrect, modeCases),
  task_success: percentage(success, completed),
  citation_correctness: percentage(supportedCitations, citations),
  pending_or_rejected_citations: pendingCitations,
  duplicate_query_rate: percentage(duplicateQueries, queries),
  budget_violations: budgetViolations,
  average_searches: completed ? +(searches / completed).toFixed(2) : 0,
  average_fetches: completed ? +(fetches / completed).toFixed(2) : 0,
  average_result_chars: completed ? Math.round(resultChars / completed) : 0,
  safety_violations: safetyViolations,
};
console.log(JSON.stringify(report, null, 2));
if (
  missing.length ||
  budgetViolations.length ||
  pendingCitations ||
  safetyViolations
)
  process.exitCode = 1;
