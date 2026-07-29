import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ReviewLoopResult } from "./models.ts";
import { describeTarget } from "./targets.ts";

/* eslint-disable no-control-regex -- Terminal sanitization intentionally matches control bytes. */

export const REVIEW_LOOP_RESULT_TYPE = "review-loop-result";
export const REVIEW_LOOP_RUN_STATE_TYPE = "review-loop-run-state";

/** Remove terminal control sequences from model, Git, and process-provided text. */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(
      /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\|$)|[PX^_][\s\S]*?(?:\x1b\\|$)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g,
      "",
    )
    .replace(/\x9d[\s\S]*?(?:\x07|\x9c|$)|[\x90\x98\x9e\x9f][\s\S]*?(?:\x9c|$)/g, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function shortReason(reason: string | undefined): string {
  if (!reason) return "";
  const oneLine = sanitizeTerminalText(reason).replaceAll("\n", " ").replace(/\s+/g, " ").trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}…`;
}

function statusLabel(result: ReviewLoopResult): string {
  const passCount = result.passes.length;
  const reason = shortReason(result.reason);
  const check = result.verification.configured
    ? result.verification.skipped
      ? "verification skipped"
      : result.verification.passed
        ? "checks passed"
        : "checks failed"
    : result.verification.command
      ? "verification skipped"
      : "review-clean; no verification configured";
  switch (result.status) {
    case "clean":
      return `Review loop clean · ${passCount} pass${passCount === 1 ? "" : "es"} · ${result.findingsFixed} findings fixed · ${check}`;
    case "blocked":
      return `Review loop blocked · ${passCount} pass${passCount === 1 ? "" : "es"}${reason ? ` · ${reason}` : ""}`;
    case "exhausted":
      return `Review loop exhausted · ${passCount} pass${passCount === 1 ? "" : "es"}${reason ? ` · ${reason}` : ""}`;
    case "aborted":
      return `Review loop aborted · ${passCount} pass${passCount === 1 ? "" : "es"} · completed edits were preserved`;
    case "failed":
      return `Review loop failed${reason ? ` · ${reason}` : ""}`;
  }
}

function icon(result: ReviewLoopResult): string {
  if (result.status === "clean") return "✓";
  if (result.status === "aborted") return "■";
  if (result.status === "blocked" || result.status === "exhausted") return "!";
  return "✗";
}

function expandedDetails(result: ReviewLoopResult): string {
  const lines = [
    `Target: ${result.target ? describeTarget(result.target) : "unresolved"}`,
    `Reviewer: ${result.reviewer.reference.provider}/${result.reviewer.reference.modelId} (${result.reviewer.thinkingLevel})`,
    `Fixer: ${result.fixer.reference.provider}/${result.fixer.reference.modelId} (${result.fixer.thinkingLevel})`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
  ];
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  lines.push("", "Passes:");
  for (const pass of result.passes) {
    const verification = pass.verification
      ? pass.verification.skipped
        ? "verification skipped"
        : pass.verification.configured
          ? pass.verification.passed
            ? "verification passed"
            : `verification failed (${pass.verification.exitCode ?? "unknown"})`
          : "no verification command"
      : "verification not run";
    lines.push(
      `  ${pass.pass}. ${pass.verdict}; ${pass.actionableFindingIds.length} actionable, ${pass.excludedFindingIds.length} excluded; ${verification}`,
    );
    if (pass.fixerSummary) lines.push(`     Fixer: ${pass.fixerSummary}`);
  }
  if (result.ledger.length > 0) {
    lines.push("", "Finding ledger:");
    for (const entry of result.ledger) {
      const status =
        entry.status === "pending"
          ? `unconfirmed ${entry.candidateStatus ?? "fixer outcome"}`
          : entry.status;
      lines.push(
        `  [${entry.priority}] ${entry.findingId} ${entry.path} · ${status} · ${entry.title}${entry.explanation ? ` — ${entry.explanation}` : ""}`,
      );
    }
  }
  if (result.excludedFindings.length > 0) {
    lines.push("", "Intentionally excluded P3 findings:");
    for (const finding of result.excludedFindings) {
      lines.push(`  ${finding.path}:${finding.startLine} ${finding.title}`);
    }
  }
  lines.push("", "Human reviewer callouts:");
  lines.push(
    ...(result.humanCallouts.length > 0
      ? result.humanCallouts.map((value) => `  ${value}`)
      : ["  (none)"]),
  );
  lines.push("", "Verification:");
  if (result.verification.skipped) {
    lines.push(
      `  ${result.verification.command ?? "Configured verification"} → skipped`,
      ...(result.verification.output
        ? [`  ${result.verification.output.replaceAll("\n", "\n  ")}`]
        : []),
    );
  } else if (!result.verification.configured) {
    lines.push("  No deterministic verification command was configured.");
  } else {
    lines.push(
      `  ${result.verification.command} → ${result.verification.passed ? "passed" : `failed (${result.verification.exitCode ?? "unknown"})`}`,
    );
    if (result.verification.output)
      lines.push(`  ${result.verification.output.replaceAll("\n", "\n  ")}`);
  }
  lines.push(
    "",
    `Usage: ${result.usage.turns} turns; ${result.usage.input} input, ${result.usage.output} output, ${result.usage.cacheRead} cache-read tokens; $${result.usage.cost.toFixed(4)}`,
  );
  if (result.status === "aborted" || (result.status !== "clean" && result.editsMayRemain)) {
    lines.push("Completed file edits remain in the worktree; no user work was discarded.");
  }
  return lines.join("\n");
}

/** Content participates in future main-session context; details remain renderer-only. */
export function resultContextContent(result: ReviewLoopResult): string {
  const lines = [
    statusLabel(result),
    result.target ? `Target: ${describeTarget(result.target)}` : "Target was not resolved.",
  ];
  if (result.reason) lines.push(`Reason: ${result.reason}`);
  if (result.verification.skipped) {
    lines.push(`Verification skipped: ${result.verification.command ?? "configured command"}`);
    if (result.verification.output) lines.push(result.verification.output.slice(-4_000));
  } else if (result.verification.configured && !result.verification.passed) {
    lines.push(
      `Verification failed: ${result.verification.command ?? "configured command"} (exit ${result.verification.exitCode ?? "unknown"})`,
    );
    if (result.verification.output) lines.push(result.verification.output.slice(-4_000));
  }
  const unresolved = result.ledger.filter(
    (entry) =>
      entry.status === "deferred" ||
      entry.status === "recurring" ||
      entry.status === "queued" ||
      entry.status === "pending",
  );
  if (unresolved.length > 0) {
    lines.push("Unresolved findings:");
    for (const entry of unresolved.slice(0, 30)) {
      const status =
        entry.status === "pending"
          ? `unconfirmed fixer report: ${entry.candidateStatus ?? "candidate outcome"}`
          : entry.status;
      lines.push(
        `- [${entry.priority}] ${entry.path}: ${entry.title} (${status})${entry.explanation ? ` — ${entry.explanation}` : ""}`,
      );
    }
  }
  if (result.excludedFindings.length > 0) {
    lines.push("P3 findings intentionally excluded by settings:");
    for (const finding of result.excludedFindings.slice(0, 30)) {
      lines.push(`- ${finding.path}:${finding.startLine} ${finding.title}`);
    }
  }
  if (result.humanCallouts.length > 0) {
    lines.push("Human reviewer callouts:", ...result.humanCallouts.map((value) => `- ${value}`));
  }
  if (result.status === "aborted") lines.push("Completed edits were intentionally left in place.");
  const content = sanitizeTerminalText(lines.join("\n"));
  return content.length <= 24_000 ? content : `${content.slice(0, 23_970)}\n[handoff truncated]`;
}

export function registerRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<ReviewLoopResult>(
    REVIEW_LOOP_RESULT_TYPE,
    (message, { expanded, outputPad }, theme) => {
      const result = message.details;
      if (!result) return new Text(sanitizeTerminalText(String(message.content)), outputPad, 0);
      const color =
        result.status === "clean" ? "success" : result.status === "failed" ? "error" : "warning";
      const summary = `${theme.fg(color, icon(result))} ${theme.fg(
        color,
        sanitizeTerminalText(statusLabel(result)),
      )}`;
      const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(
        new Text(
          expanded
            ? `${summary}\n\n${theme.fg("muted", sanitizeTerminalText(expandedDetails(result)))}`
            : summary,
          0,
          0,
        ),
      );
      return box;
    },
  );
}
