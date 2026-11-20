import type { Api, Model } from "@earendil-works/pi-ai";
import type { FastCapability } from "./capabilities.ts";
import { safeLabel, type FastRequestRecord } from "./diagnostics.ts";
import { snapshotSpeed, type FastStateSnapshot } from "./monitor.ts";
import { effectiveSpeed, type FastFallbacks } from "./speed.ts";

export const FAST_MODE_STATUS_KEY = "fast-mode";

const SPEED_NAMES = { off: "off", fast: "Fast", ultrafast: "Ultrafast" } as const;

/** Minimal footer status; commands retain the full preference/capability explanation. */
export function formatFastFooterStatus(
  state: FastStateSnapshot,
  capability: FastCapability,
  model?: Model<Api>,
  fallbacks?: FastFallbacks,
): string | undefined {
  if (state.error) return "speed (!)";
  const preference = snapshotSpeed(state);
  if (preference === undefined) return "speed (?)";
  if (preference === "off") return undefined;
  const speed = effectiveSpeed(preference, capability, model, fallbacks);
  if (speed === "ultrafast") return "speed (ultrafast)";
  if (speed === "fast")
    return preference !== "ultrafast"
      ? "speed (fast)"
      : capability.ultrafast === "unknown"
        ? "speed (fast, ultra ?)"
        : "speed (fast, no ultra)";
  if (model && (fallbacks?.blocked(model, "fast") || fallbacks?.blocked(model, "ultrafast")))
    return "speed (standard, fallback)";
  if (capability.status === "unknown" || capability.ultrafast === "unknown") return "speed (?)";
  return "speed (unavailable)";
}

export function formatFastStatus(state: FastStateSnapshot, capability: FastCapability): string {
  if (state.error) return "fast error";
  const preference = snapshotSpeed(state);
  if (preference === undefined) return "fast unknown";
  if (preference === "off") return "fast off";
  const name = preference === "ultrafast" ? "ultrafast" : "fast";
  if (
    preference === "ultrafast" &&
    capability.ultrafast !== "supported" &&
    capability.status === "supported"
  )
    return capability.ultrafast === "unknown"
      ? `${name} on · Fast now, Ultrafast support unknown`
      : `${name} on · Fast only for this model`;
  if (capability.status === "unsupported" && capability.ultrafast !== "supported")
    return `${name} on · unavailable for this model`;
  if (capability.status === "unknown" && capability.ultrafast !== "supported")
    return `${name} on · support unknown`;
  return `${name} on`;
}

export function formatFastDetails(
  state: FastStateSnapshot,
  model: Model<Api> | undefined,
  capability: FastCapability,
  last?: FastRequestRecord,
  discoveryError?: string,
  fallbacks?: FastFallbacks,
  adapterLabel?: string,
): string {
  const preference = snapshotSpeed(state);
  const speed =
    preference === undefined ? undefined : effectiveSpeed(preference, capability, model, fallbacks);
  const next =
    preference === undefined
      ? "unknown (state unavailable)"
      : speed === "ultrafast"
        ? `request Ultrafast${capability.ultrafastTier ? ` (${safeLabel(capability.ultrafastTier)})` : ""}`
        : speed === "fast"
          ? "request Fast"
          : "leave the caller's speed unchanged";
  const lines = [
    `${formatFastStatus(state, capability)} (global)`,
    `Model: ${model ? `${safeLabel(model.provider)}/${safeLabel(model.id)}` : "none"}${adapterLabel ? ` via ${adapterLabel}` : ""}`,
    `Fast: ${capability.status}; Ultrafast: ${capability.ultrafast} (${capability.source}). ${capability.reason}`,
    `Next request: ${next}. Model and reasoning are unchanged.`,
  ];
  if (state.error) lines.push(state.error);
  if (discoveryError) lines.push(discoveryError);
  if (model && fallbacks) {
    for (const blocked of ["ultrafast", "fast"] as const) {
      const block = fallbacks.blocked(model, blocked);
      if (block)
        lines.push(
          `${SPEED_NAMES[blocked]} paused for this model: ${block.reason}${block.until ? ` until ${new Date(block.until).toISOString()}` : " until /fast refresh or a speed change"}.`,
        );
    }
  }
  if (preference && preference !== "off")
    lines.push(
      "Fast and Ultrafast cost more (plan credits or premium token rates) and use separate prompt caches. Account terms apply.",
    );
  if (last) {
    const applied = last.appliedSpeed
      ? `set by this extension: ${SPEED_NAMES[last.appliedSpeed]}`
      : "caller/default";
    lines.push(
      `Last request #${last.id}: ${last.model} at ${new Date(last.startedAt).toISOString()}`,
      `Requested tier: ${last.requestedTier} (${applied}).`,
      `Transport: configured ${last.configuredTransport}; observed ${last.observedTransport}${last.httpStatus === undefined ? "" : `; HTTP ${last.httpStatus}`}.`,
      `Response reports: ${last.responseTier ?? "unknown"}. This is not independent proof of admission or billing.`,
    );
    if (last.fellBackTo) lines.push(`Retried at ${last.fellBackTo} after a refusal.`);
    if (last.firstOutputMs !== undefined) lines.push(`First output: ${last.firstOutputMs}ms.`);
    if (last.completedMs !== undefined)
      lines.push(`Provider completion: ${last.completedMs}ms (not total tool/task time).`);
  } else {
    lines.push("Last request: none observed by this extension instance.");
  }
  lines.push(
    "Changing the preference does not change a request already sent. Off does not override another caller's tier.",
  );
  return lines.join("\n");
}
