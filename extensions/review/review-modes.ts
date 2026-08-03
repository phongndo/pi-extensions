import type { ReviewMode } from "./models.ts";

export interface ReviewerProfile {
  id: string;
  label: string;
  instructions: string;
}

const PROFILES: Record<ReviewMode, readonly ReviewerProfile[]> = {
  standard: [
    {
      id: "general",
      label: "General reviewer",
      instructions:
        "Perform a balanced review across correctness, security, performance, operability, maintainability, and regression coverage.",
    },
  ],
  adversarial: [
    {
      id: "root-cause",
      label: "Adversarial root-cause reviewer",
      instructions:
        "Reconstruct the intended outcome and causal chain before judging the patch. Determine whether the change fixes the root cause or merely compensates for a symptom at the wrong layer. Challenge ownership, sources of truth, invariants, state transitions, and responsibility boundaries. Flag concrete cases where the change entrenches duplicated state, compensating checks, retries, fallbacks, or fragile coupling. Recommend the root-level correction rather than another local patch, and tie every finding to direct evidence in the change.",
    },
    {
      id: "system-design",
      label: "Adversarial system-design reviewer",
      instructions:
        "Question the premise and architecture of the change, not only whether its code works locally. Trace the complete end-to-end system through callers, callees, contracts, data and control flow, lifecycle, concurrency, configuration, rollout, and failure recovery. Seek concrete counterexamples and compare the approach with simpler designs that remove mechanisms, state, branches, or translation layers. Report a design finding only when evidence shows the current change reinforces a poor system design, and explain the better system-level direction instead of proposing a symptom-level fix.",
    },
  ],
  security: [
    {
      id: "trust-boundaries",
      label: "Security trust-boundary reviewer",
      instructions:
        "Trace untrusted data and identity across trust boundaries. Focus on authentication, authorization, injection, path and URL handling, secret exposure, unsafe deserialization, and privilege changes. Require a concrete exploit or violated invariant for each finding.",
    },
    {
      id: "abuse-cases",
      label: "Security abuse-case reviewer",
      instructions:
        "Approach the change as an attacker and an unreliable dependency. Look for bypasses, denial of service, race conditions, confused-deputy behavior, insecure defaults, supply-chain risk, and unsafe failure modes. Require concrete evidence rather than generic hardening advice.",
    },
  ],
  migration: [
    {
      id: "behavioral-equivalence",
      label: "Migration equivalence reviewer",
      instructions:
        "Compare old and new behavior side by side. Trace successful, failing, boundary, cleanup, and concurrency paths and report concrete semantic differences that are not explicitly intended.",
    },
    {
      id: "compatibility",
      label: "Migration compatibility reviewer",
      instructions:
        "Focus on API and data compatibility, ownership and lifetime changes, platform behavior, serialization, configuration defaults, rollout and rollback, performance-sensitive semantics, and missing migration coverage. Require direct evidence for each finding.",
    },
  ],
};

function combinedProfile(mode: ReviewMode, profiles: readonly ReviewerProfile[]): ReviewerProfile {
  if (profiles.length === 1) return { ...profiles[0]! };
  return {
    id: mode,
    label: `${mode[0]!.toUpperCase()}${mode.slice(1)} reviewer`,
    instructions: [
      `Cover every ${mode} perspective in this single-agent panel:`,
      ...profiles.map((profile) => `- ${profile.instructions}`),
    ].join("\n"),
  };
}

export function reviewerProfilesForMode(
  mode: ReviewMode,
  count = reviewerCountForMode(mode),
): ReviewerProfile[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Reviewer count must be a positive integer.");
  }
  const profiles = PROFILES[mode];
  if (count === 1) return [combinedProfile(mode, profiles)];
  return Array.from({ length: count }, (_value, index) => {
    const profile = profiles[index % profiles.length]!;
    const cycle = Math.floor(index / profiles.length) + 1;
    return cycle === 1
      ? { ...profile }
      : {
          ...profile,
          id: `${profile.id}-${cycle}`,
          label: `${profile.label} ${cycle}`,
        };
  });
}

/** Existing mode-specific panel size, used when migrating settings without reviewerCount. */
export function reviewerCountForMode(mode: ReviewMode): number {
  return PROFILES[mode].length;
}
