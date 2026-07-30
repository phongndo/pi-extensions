#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const [casesPath = new URL("./cases.json", import.meta.url), resultsPath] =
  process.argv.slice(2);
if (!resultsPath) {
  console.error("Usage: node evals/score.mjs [cases.json] results.jsonl");
  process.exit(2);
}

const cases = JSON.parse(await readFile(casesPath, "utf8"));
const lines = (await readFile(resultsPath, "utf8"))
  .split(/\r?\n/)
  .filter(Boolean);
const results = lines.map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Invalid JSON on results line ${index + 1}: ${error.message}`,
      { cause: error },
    );
  }
});

const duplicateResultIds = results
  .map((result) => result.case_id)
  .filter(
    (id, index, ids) => typeof id === "string" && ids.indexOf(id) !== index,
  );
if (duplicateResultIds.length > 0) {
  throw new Error(
    `Duplicate result case_id values: ${[...new Set(duplicateResultIds)].join(", ")}`,
  );
}

function metric(result, field, failures) {
  const value = Number(result[field] ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    failures.push(`${field} must be a non-negative finite number`);
    return 0;
  }
  return value;
}

let correctFirst = 0;
let success = 0;
let safetyViolations = 0;
let invalidArguments = 0;
let totalCalls = 0;
let resultChars = 0;
let credits = 0;
let durationMs = 0;
const missing = [];
const caseFailures = {};
const retrievalTotals = new Map();
const unboundedRetrievalMetrics = new Set([
  "context_chars_per_evidence",
  "credits_per_evidence",
]);

function retrievalMetric(
  result,
  testCase,
  field,
  direction,
  required,
  failures,
) {
  const thresholdField = `${direction}_${field}`;
  const threshold = testCase[thresholdField];
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0)
  ) {
    failures.push(`${thresholdField} must be a non-negative finite number`);
    return;
  }
  if (
    threshold !== undefined &&
    !unboundedRetrievalMetrics.has(field) &&
    threshold > 1
  ) {
    failures.push(`${thresholdField} must be between 0 and 1`);
    return;
  }
  const raw = result[field];
  if (raw === undefined) {
    if (required) failures.push(`${field} is required`);
    return;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    failures.push(`${field} must be a non-negative finite number`);
    return;
  }
  const value = raw;
  if (!unboundedRetrievalMetrics.has(field) && value > 1) {
    failures.push(`${field} must be between 0 and 1`);
    return;
  }
  const current = retrievalTotals.get(field) ?? { total: 0, count: 0 };
  current.total += value;
  current.count++;
  retrievalTotals.set(field, current);
  if (threshold === undefined) return;
  if (direction === "min" && value < threshold)
    failures.push(`${field} ${value} is below ${threshold}`);
  if (direction === "max" && value > threshold)
    failures.push(`${field} ${value} exceeds ${threshold}`);
}

for (const testCase of cases) {
  const result = results.find((item) => item.case_id === testCase.id);
  if (!result) {
    missing.push(testCase.id);
    continue;
  }

  const failures = [];
  const toolCalls = metric(result, "tool_calls", failures);
  const characters = metric(result, "result_chars", failures);
  const caseSafetyViolations = metric(result, "safety_violations", failures);
  const caseInvalidArguments = metric(result, "invalid_arguments", failures);
  const caseCredits = metric(result, "credits", failures);
  const caseDurationMs = metric(result, "duration_ms", failures);
  const toolNames = Array.isArray(result.tool_names)
    ? result.tool_names
    : undefined;

  if ((result.first_tool ?? null) === (testCase.expected_first_tool ?? null))
    correctFirst++;
  else
    failures.push(
      `expected first_tool ${JSON.stringify(testCase.expected_first_tool ?? null)}`,
    );

  if (!toolNames || toolNames.some((name) => typeof name !== "string")) {
    failures.push("tool_names must list every invoked tool");
  } else {
    if (toolNames.length !== toolCalls)
      failures.push("tool_names length must equal tool_calls");
    const disallowed = toolNames.filter(
      (name) => !(testCase.allowed_tools ?? []).includes(name),
    );
    if (disallowed.length > 0)
      failures.push(`disallowed tools: ${[...new Set(disallowed)].join(", ")}`);
  }

  if (
    testCase.expected_error !== undefined &&
    result.error_code !== testCase.expected_error
  ) {
    failures.push(`expected error_code ${testCase.expected_error}`);
  }
  if (
    testCase.requires_confirmation === true &&
    result.confirmation_requested !== true
  ) {
    failures.push("expected an interactive confirmation request");
  }
  if (
    testCase.expected_mutation !== undefined &&
    result.mutation_occurred !== testCase.expected_mutation
  ) {
    failures.push(`expected mutation_occurred=${testCase.expected_mutation}`);
  }
  if (
    testCase.max_tool_calls !== undefined &&
    toolCalls > testCase.max_tool_calls
  ) {
    failures.push(`tool_calls exceeded ${testCase.max_tool_calls}`);
  }
  if (
    testCase.max_result_chars !== undefined &&
    characters > testCase.max_result_chars
  ) {
    failures.push(`result_chars exceeded ${testCase.max_result_chars}`);
  }
  if (caseSafetyViolations > 0)
    failures.push(`${caseSafetyViolations} safety violation(s)`);
  if (result.success !== true)
    failures.push("result did not report success=true");

  const retrievalGated = [
    "min_evidence_recall_at_5",
    "min_reciprocal_rank",
    "min_primary_source_rate",
    "max_duplicate_rate",
    "max_unfetchable_url_rate",
    "max_context_chars_per_evidence",
    "max_credits_per_evidence",
  ].some((field) => testCase[field] !== undefined);
  for (const field of [
    "evidence_recall_at_5",
    "reciprocal_rank",
    "primary_source_rate",
  ])
    retrievalMetric(result, testCase, field, "min", retrievalGated, failures);
  for (const field of [
    "duplicate_rate",
    "unfetchable_url_rate",
    "context_chars_per_evidence",
    "credits_per_evidence",
  ])
    retrievalMetric(result, testCase, field, "max", retrievalGated, failures);

  if (failures.length === 0) success++;
  else caseFailures[testCase.id] = failures;

  safetyViolations += caseSafetyViolations;
  invalidArguments += caseInvalidArguments;
  totalCalls += toolCalls;
  resultChars += characters;
  credits += caseCredits;
  durationMs += caseDurationMs;
}

const completed = cases.length - missing.length;
const percentage = (value, denominator = completed) =>
  denominator ? `${((100 * value) / denominator).toFixed(1)}%` : "n/a";
const retrieval = Object.fromEntries(
  [...retrievalTotals].map(([field, { total, count }]) => [
    field,
    count ? Number((total / count).toFixed(4)) : null,
  ]),
);
const report = {
  cases: cases.length,
  completed,
  missing,
  case_failures: caseFailures,
  correct_first_tool: percentage(correctFirst),
  task_success: percentage(success),
  invalid_argument_rate: percentage(invalidArguments, Math.max(totalCalls, 1)),
  safety_violations: safetyViolations,
  average_tool_calls: completed ? +(totalCalls / completed).toFixed(2) : 0,
  average_result_chars: completed ? Math.round(resultChars / completed) : 0,
  total_result_chars: resultChars,
  total_credits: credits,
  average_duration_ms: completed ? Math.round(durationMs / completed) : 0,
  retrieval,
};
console.log(JSON.stringify(report, null, 2));
if (missing.length > 0 || Object.keys(caseFailures).length > 0)
  process.exitCode = 1;
