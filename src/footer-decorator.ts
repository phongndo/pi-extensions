import { FooterComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type SessionManager = ExtensionContext["sessionManager"];
type Decorator = (lines: string[], model: ExtensionContext["model"], width: number) => string[];
type Render = FooterComponent["render"];
const INSTALLATION = Symbol.for("dp.pi-extensions.footer-decorators");
interface Installation {
  decorators: Map<SessionManager, Set<Decorator>>;
  original: Render;
  render: Render;
}
type Prototype = typeof FooterComponent.prototype & { [INSTALLATION]?: Installation };
interface FooterSession {
  session?: { sessionManager?: SessionManager; state?: { model?: ExtensionContext["model"] } };
}

/**
 * Pi has no public inline-footer slot. Keep that compatibility seam here rather
 * than replacing its footer or stacking independent prototype wrappers. Custom
 * footers are untouched; registrations are session-scoped and independently disposable.
 */
export function installFooterDecorator(owner: SessionManager, decorate: Decorator): () => void {
  const prototype = FooterComponent.prototype as Prototype;
  let installation = prototype[INSTALLATION];
  if (!installation) {
    const decorators = new Map<SessionManager, Set<Decorator>>();
    const original = prototype.render;
    const render: Render = function (this: FooterComponent, width) {
      let lines = original.call(this, width);
      const session = (this as unknown as FooterSession).session;
      const readers = session?.sessionManager && decorators.get(session.sessionManager);
      if (readers) {
        for (const reader of readers) lines = reader(lines, session?.state?.model, width);
      }
      return lines;
    };
    installation = { decorators, original, render };
    try {
      Object.defineProperty(prototype, INSTALLATION, { configurable: true, value: installation });
      prototype.render = render;
    } catch (error) {
      if (prototype.render === render) prototype.render = original;
      if (prototype[INSTALLATION] === installation) delete prototype[INSTALLATION];
      throw new Error("Could not decorate Pi's built-in footer.", { cause: error });
    }
  }
  const installed = installation;
  const reader: Decorator = (...args) => decorate(...args);
  const readers = installed.decorators.get(owner) ?? new Set<Decorator>();
  readers.add(reader);
  installed.decorators.set(owner, readers);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    readers.delete(reader);
    if (readers.size === 0) installed.decorators.delete(owner);
    if (installed.decorators.size > 0) return;
    if (prototype.render === installed.render) prototype.render = installed.original;
    if (prototype[INSTALLATION] === installed) delete prototype[INSTALLATION];
  };
}
