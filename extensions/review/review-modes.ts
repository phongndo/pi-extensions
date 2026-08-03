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
      id: "adversarial",
      label: "Adversarial reviewer",
      instructions:
        "Assume the change is wrong and find a concrete way it fails. You are a fresh reviewer with none of the author's reasoning: trust only the diff, repository evidence, governing project guidance, and behavior you can verify yourself. Inspect the complete change and trace relevant callers, state, ownership, lifetimes, error paths, concurrency, and platform behavior. For ports, rewrites, and refactors, compare old and new semantics directly. Actively construct counterexamples, especially for boundaries, signs and units, rounding, eager versus lazy evaluation, cleanup, and failure paths. Report only provable bugs with a root-cause correction; do not substitute style advice, generic hardening, or speculative redesign for finding the way the change is wrong.",
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

/** Mode-specific panel size, used when settings do not specify reviewerCount. */
export function reviewerCountForMode(mode: ReviewMode): number {
  return mode === "adversarial" ? 2 : 1;
}
