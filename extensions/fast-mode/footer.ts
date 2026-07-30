import type { Api, Model } from "@earendil-works/pi-ai";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { supportsCodexFastMode } from "./policy.ts";

const FAST_MODE_GLYPH = "ϟ";
const FOOTER_INSTALLATION = Symbol("pi-fast-mode.footer-prefix");

type FooterRender = FooterComponent["render"];

interface FastModeFooterInstallation {
  readers: Set<() => boolean>;
  originalRender: FooterRender;
  render: FooterRender;
}

type FastModeFooterPrototype = typeof FooterComponent.prototype & {
  [FOOTER_INSTALLATION]?: FastModeFooterInstallation;
};

interface FooterWithSession {
  session?: { state?: { model?: Model<Api> } };
}

export function prefixFastModeModelLine(
  lines: string[],
  model: Model<Api> | undefined,
  enabled: boolean,
): string[] {
  if (!enabled || !supportsCodexFastMode(model)) return lines;

  const modelLine = lines[1];
  if (modelLine === undefined) return lines;

  const modelIndex = modelLine.lastIndexOf(model.id);
  if (modelIndex < 0) return lines;

  const providerText = `(${model.provider}) `;
  const providerIndex = modelLine.lastIndexOf(providerText, modelIndex);
  const rightSideIndex = providerIndex >= 0 ? providerIndex : modelIndex;
  const prefix = modelLine.slice(0, rightSideIndex);

  // The built-in footer reserves at least two spaces before its model section. Reuse
  // those cells for the glyph so the decorated line keeps exactly the same width.
  if (!prefix.endsWith("  ")) return lines;

  const rightSide = modelLine.slice(rightSideIndex);
  const modelIndexInRightSide = rightSide.lastIndexOf(model.id);
  if (modelIndexInRightSide < 0) return lines;

  const nextLines = [...lines];
  nextLines[1] =
    prefix.slice(0, -2) +
    rightSide.slice(0, modelIndexInRightSide) +
    `${FAST_MODE_GLYPH} ` +
    rightSide.slice(modelIndexInRightSide);
  return nextLines;
}

/** Decorate only Pi's built-in footer, leaving extension-provided custom footers alone. */
export function installFastModeFooterPrefix(readEnabled: () => boolean): () => void {
  const prototype = FooterComponent.prototype as FastModeFooterPrototype;
  let installation = prototype[FOOTER_INSTALLATION];

  if (!installation) {
    const readers = new Set([readEnabled]);
    const originalRender = prototype.render;
    const render: FooterRender = function (this: FooterComponent, width) {
      const lines = originalRender.call(this, width);
      const model = (this as unknown as FooterWithSession).session?.state?.model;
      const enabled = Array.from(readers).some((reader) => reader());
      return prefixFastModeModelLine(lines, model, enabled);
    };
    installation = { readers, originalRender, render };
    Object.defineProperty(prototype, FOOTER_INSTALLATION, {
      configurable: true,
      value: installation,
    });
    prototype.render = render;
  } else {
    installation.readers.add(readEnabled);
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    installation!.readers.delete(readEnabled);
    if (installation!.readers.size > 0) return;

    if (prototype.render === installation!.render) {
      prototype.render = installation!.originalRender;
    }
    if (prototype[FOOTER_INSTALLATION] === installation) {
      delete prototype[FOOTER_INSTALLATION];
    }
  };
}
