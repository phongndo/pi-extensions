import type { Api, Model } from "@earendil-works/pi-ai";
import type { FastCapability } from "./capabilities.ts";
import { safeLabel, type FastRequestRecord } from "./diagnostics.ts";
import type { FastStateSnapshot } from "./monitor.ts";

export const FAST_MODE_STATUS_KEY = "fast-mode";

/** Minimal footer status; commands retain the full preference/capability explanation. */
export function formatFastFooterStatus(
  state: FastStateSnapshot,
  capability: FastCapability,
): string | undefined {
  if (state.error) return "speed !";
  if (state.enabled === undefined) return "speed ?";
  if (!state.enabled) return undefined;
  if (capability.status === "unsupported") return "speed unavailable";
  if (capability.status === "unknown") return "speed ?";
  return "speed fast";
}

export function formatFastStatus(state: FastStateSnapshot, capability: FastCapability): string {
  if (state.error) return "fast error";
  if (state.enabled === undefined) return "fast unknown";
  if (!state.enabled) return "fast off";
  if (capability.status === "unsupported") return "fast on · unavailable for this model";
  if (capability.status === "unknown") return "fast on · support unknown";
  return "fast on";
}

export function formatFastDetails(
  state: FastStateSnapshot,
  model: Model<Api> | undefined,
  capability: FastCapability,
  last?: FastRequestRecord,
  discoveryError?: string,
): string {
  const next =
    state.error || state.enabled === undefined
      ? "unknown (state unavailable)"
      : state.enabled && capability.status === "supported"
        ? "request priority"
        : "leave caller's service tier unchanged";
  const lines = [
    `${formatFastStatus(state, capability)} (global)`,
    `Model: ${model ? `${safeLabel(model.provider)}/${safeLabel(model.id)}` : "none"}`,
    `Support: ${capability.status} (${capability.source}). ${capability.reason}`,
    `Next request: ${next}. Reasoning is unchanged.`,
  ];
  if (state.error) lines.push(state.error);
  if (discoveryError) lines.push(discoveryError);
  if (state.enabled)
    lines.push(
      "Fast can use more credits (Astra: 2.5× Standard where available). Account terms apply.",
    );
  if (last) {
    lines.push(
      `Last request #${last.id}: ${last.model} at ${new Date(last.startedAt).toISOString()}`,
      `Requested tier: ${last.requestedTier} (${last.applied ? "set by Fast mode" : "caller/default"}).`,
      `Transport: configured ${last.configuredTransport}; observed ${last.observedTransport}${last.httpStatus === undefined ? "" : `; HTTP ${last.httpStatus}`}.`,
      `Response reports: ${last.responseTier ?? "unknown"}. This is not independent proof of priority admission or billing.`,
    );
    if (last.firstOutputMs !== undefined) lines.push(`First output: ${last.firstOutputMs}ms.`);
    if (last.completedMs !== undefined)
      lines.push(`Provider completion: ${last.completedMs}ms (not total tool/task time).`);
    if (last.observedTransport === "unknown")
      lines.push("Pi does not expose raw WebSocket response tiers to this extension.");
  } else {
    lines.push("Last request: none observed by this extension instance.");
  }
  lines.push(
    "Changing the preference does not change a request already sent. Off does not override another caller's priority tier.",
  );
  return lines.join("\n");
}
