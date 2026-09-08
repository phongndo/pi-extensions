import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Status = {
  text: string;
  publish: (text: string | undefined) => void;
  rendered: string | undefined;
};
// Independently loaded extensions must share separators, including across /reload.
const STATE = Symbol.for("dp.pi-extensions.footer-status");
const shared = globalThis as typeof globalThis & { [STATE]?: WeakMap<object, Map<string, Status>> };
const sessions = (shared[STATE] ??= new WeakMap<object, Map<string, Status>>());

/** Native status slots, with separators between this package's visible labels. */
export function setFooterStatus(
  ctx: ExtensionContext,
  key: string,
  text: string | undefined,
): void {
  if (!ctx.hasUI) return;
  const owner = ctx.sessionManager ?? ctx;
  let statuses = sessions.get(owner);
  if (!statuses) {
    statuses = new Map();
    sessions.set(owner, statuses);
  }
  const errors: unknown[] = [];
  if (text === undefined) {
    statuses.delete(key);
    try {
      ctx.ui.setStatus(key, undefined);
    } catch (error) {
      errors.push(error);
    }
  } else {
    const previous = statuses.get(key);
    statuses.set(key, {
      text,
      publish: (value) => ctx.ui.setStatus(key, value),
      rendered: previous?.rendered,
    });
  }
  let visible = 0;
  for (const [statusKey, status] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
    const rendered = `${visible ? "· " : ""}${status.text}`;
    try {
      if (status.rendered !== rendered) {
        status.publish(rendered);
        status.rendered = rendered;
      }
      visible++;
    } catch (error) {
      // A stale extension UI must not poison unrelated publishers or separators.
      statuses.delete(statusKey);
      errors.push(error);
    }
  }
  if (!statuses.size) sessions.delete(owner);
  if (errors.length) throw errors[0];
}
