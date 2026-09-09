import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SESSION_ACCOUNT_ENTRY, sessionAccounts } from "../session.ts";

test("session accounts survive disk reopen and compaction, stay provider-scoped, and follow branches", () => {
  const directory = mkdtempSync(join(tmpdir(), "router-session-"));
  try {
    const session = SessionManager.create(directory, directory);
    session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "test",
      model: "test",
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const first = session.appendCustomEntry(SESSION_ACCOUNT_ENTRY, {
      provider: "test",
      accountId: "b",
    });
    session.appendCustomEntry(SESSION_ACCOUNT_ENTRY, { provider: "other", accountId: "c" });
    session.appendCompaction("summary", first, 100);
    const reopened = SessionManager.open(session.getSessionFile()!);
    expect([...sessionAccounts(reopened.getBranch())]).toEqual([
      ["test", "b"],
      ["other", "c"],
    ]);
    reopened.appendCustomEntry(SESSION_ACCOUNT_ENTRY, { provider: "test", accountId: null });
    reopened.appendCustomEntry(SESSION_ACCOUNT_ENTRY, { provider: "other", accountId: 123 });
    expect([...sessionAccounts(reopened.getBranch())]).toEqual([["other", "c"]]);
    reopened.branch(first);
    expect([...sessionAccounts(reopened.getBranch())]).toEqual([["test", "b"]]);
    expect(sessionAccounts(SessionManager.inMemory().getBranch()).size).toBe(0);
    expect(
      reopened
        .buildSessionContext()
        .messages.some((m) => "customType" in m && m.customType === SESSION_ACCOUNT_ENTRY),
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
