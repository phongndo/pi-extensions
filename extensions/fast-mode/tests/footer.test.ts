import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { FooterComponent, SessionManager, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { installFastModeFooterPrefix, prefixFastModeModelLine } from "../footer.ts";
import { model } from "./helpers.ts";

function footer(sessionManager: SessionManager): FooterComponent {
  const session = {
    state: { model: model(), thinkingLevel: "xhigh" },
    sessionManager,
    getContextUsage: () => undefined,
    modelRuntime: { isUsingSubscription: () => true },
  } as unknown as ConstructorParameters<typeof FooterComponent>[0];
  const data = {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map(),
  } as unknown as ConstructorParameters<typeof FooterComponent>[1];
  return new FooterComponent(session, data);
}

test("original text glyph sits immediately before the model without changing width or ANSI styling", () => {
  for (const provider of ["", "(openai-codex) "]) {
    const lines = ["~/project", `\u001b[2mstats    ${provider}gpt-6-astra • xhigh\u001b[0m`];
    const prefixed = prefixFastModeModelLine(lines, model(), true);
    assert.equal(stripVTControlCharacters(prefixed[1]!), `stats  ${provider}ϟ gpt-6-astra • xhigh`);
    assert.equal(visibleWidth(prefixed[1]!), visibleWidth(lines[1]!));
    assert.ok(prefixed[1]!.startsWith("\u001b[2m") && prefixed[1]!.endsWith("\u001b[0m"));
    assert.equal(
      prefixFastModeModelLine(prefixed, model(), true),
      prefixed,
      "do not double-prefix",
    );
    assert.equal(prefixFastModeModelLine(lines, model(), false), lines);
  }
});

test("inline indicator is session-scoped and duplicate registrations survive out-of-order teardown", () => {
  initTheme("dark", false);
  const first = SessionManager.inMemory();
  const second = SessionManager.inMemory();
  const firstFooter = footer(first);
  const secondFooter = footer(second);
  const original = FooterComponent.prototype.render;
  const enabled = () => true;
  const removeFirst = installFastModeFooterPrefix(first, enabled);
  const decorated = FooterComponent.prototype.render;
  const removeDuplicate = installFastModeFooterPrefix(first, enabled);
  const removeSecond = installFastModeFooterPrefix(second, () => false);
  try {
    assert.equal(FooterComponent.prototype.render, decorated);
    assert.match(stripVTControlCharacters(firstFooter.render(120)[1]!), /ϟ gpt-6-astra/);
    assert.doesNotMatch(secondFooter.render(120)[1]!, /ϟ/);
    removeFirst();
    assert.match(stripVTControlCharacters(firstFooter.render(120)[1]!), /ϟ gpt-6-astra/);
    removeDuplicate();
    assert.doesNotMatch(firstFooter.render(120)[1]!, /ϟ/);
    assert.equal(
      FooterComponent.prototype.render,
      decorated,
      "second session still owns the decorator",
    );
  } finally {
    removeFirst();
    removeDuplicate();
    removeSecond();
  }
  assert.equal(FooterComponent.prototype.render, original);
});
