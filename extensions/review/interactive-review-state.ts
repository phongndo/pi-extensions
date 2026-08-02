import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const INTERACTIVE_REVIEW_STATE_TYPE = "review-session";

/** Check the effective interactive-review state on the current session branch. */
export function isInteractiveReviewActive(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
  let active = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== INTERACTIVE_REVIEW_STATE_TYPE) continue;
    const data: unknown = entry.data;
    active = typeof data === "object" && data !== null && "active" in data && data.active === true;
  }
  return active;
}
