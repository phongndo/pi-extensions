import type { Api, Model } from "@earendil-works/pi-ai";

export const REQUEST_SPEED_PREFERENCES = ["inherit", "standard", "fast", "ultrafast"] as const;
export type RequestSpeedPreference = (typeof REQUEST_SPEED_PREFERENCES)[number];
export type RequestSpeedTier = Exclude<RequestSpeedPreference, "inherit">;
export type SpeedSupport = "supported" | "unsupported" | "unknown";

export interface RequestSpeedSupport {
  fast: SpeedSupport;
  ultrafast: SpeedSupport;
}

export interface RequestSpeedReport {
  /** Resolved preference, including the global setting when inherited. */
  preferred: RequestSpeedTier;
  /** First tier selected for the payload. Standard means no premium tier was requested. */
  requested: RequestSpeedTier;
  fellBackTo?: RequestSpeedTier;
  reportedTier?: string;
}

export interface RequestSpeedControl {
  preference: RequestSpeedPreference;
  /** Set by the policy, not by the caller. Read after the stream finishes. */
  report?: () => RequestSpeedReport;
}

// Pi can load the extensions in separate module instances. The options key survives
// Pi's spreads without becoming part of the wire payload. There is no shared request state.
export const REQUEST_SPEED = Symbol.for("dp.pi-extensions.request-speed");
export const REQUEST_SPEED_SUPPORT = Symbol.for("dp.pi-extensions.request-speed-support");

export interface RequestSpeedOptions {
  [REQUEST_SPEED]?: RequestSpeedControl;
}

export interface RequestSpeedSupportLookup {
  [REQUEST_SPEED_SUPPORT]?: (model: Model<Api>) => RequestSpeedSupport;
}

export function isRequestSpeedPreference(value: unknown): value is RequestSpeedPreference {
  return REQUEST_SPEED_PREFERENCES.some((preference) => preference === value);
}

export const REQUEST_SPEED_LABELS: Record<RequestSpeedPreference, string> = {
  inherit: "Inherit",
  standard: "Standard",
  fast: "Fast",
  ultrafast: "Ultrafast",
};
