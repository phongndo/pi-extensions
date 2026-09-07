import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installFooterDecorator } from "../../src/footer-decorator.ts";
import type { FastCapability } from "./capabilities.ts";
import { safeLabel, type FastRequestRecord } from "./diagnostics.ts";
import type { FastStateSnapshot } from "./monitor.ts";

export const FAST_MODE_STATUS_KEY = "fast-mode";
const FAST_MODE_GLYPH = "ϟ";

/** Reuse the model section's existing padding, keeping ANSI styling and line width unchanged. */
export function prefixFastModeModelLine(
  lines: string[],
  model: Model<Api> | undefined,
  showPrefix: boolean,
): string[] {
  if (!showPrefix || !model) return lines;
  const line = lines[1];
  if (line === undefined) return lines;
  const modelIndex = line.lastIndexOf(model.id);
  if (modelIndex < 0 || line.slice(0, modelIndex).endsWith(`${FAST_MODE_GLYPH} `)) return lines;
  const providerIndex = line.lastIndexOf(`(${model.provider}) `, modelIndex);
  const rightSideIndex = providerIndex >= 0 ? providerIndex : modelIndex;
  const prefix = line.slice(0, rightSideIndex);
  if (!prefix.endsWith("  ")) return lines;
  const result = [...lines];
  result[1] =
    prefix.slice(0, -2) +
    line.slice(rightSideIndex, modelIndex) +
    `${FAST_MODE_GLYPH} ` +
    line.slice(modelIndex);
  return result;
}

/** Decorate only the built-in footer, scoped to its session; custom footers remain untouched. */
export function installFastModeFooterPrefix(
  sessionManager: ExtensionContext["sessionManager"],
  readEnabled: (model: Model<Api> | undefined) => boolean,
): () => void {
  return installFooterDecorator(sessionManager, (lines, model) =>
    prefixFastModeModelLine(lines, model, readEnabled(model)),
  );
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
