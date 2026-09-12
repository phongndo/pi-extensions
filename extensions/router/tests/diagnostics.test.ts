import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  DIAGNOSTIC_ENTRY,
  diagnosticSecrets,
  formatDiagnostics,
  sanitizeDiagnostic,
  sessionDiagnostics,
  upstreamDiagnostic,
  type RouterDiagnostic,
} from "../diagnostics.ts";

const diagnostic: RouterDiagnostic = {
  timestamp: 1000,
  provider: "test",
  model: "model",
  accountId: "account-2",
  stage: "request",
  category: "request",
  status: 400,
  replaySafe: true,
  upstream: "Invalid tool result: missing call_id for tool output",
};

test("upstream wording, codes, and nested causes survive without attached payloads or stack traces", () => {
  const error = Object.assign(
    new Error("Request failed", {
      cause: Object.assign(new Error("Connection reset by peer"), { code: "ECONNRESET" }),
    }),
    { request: { prompt: "PRIVATE PROMPT" }, headers: { authorization: "PRIVATE TOKEN" } },
  );
  const text = upstreamDiagnostic(error);
  expect(text).toBe("Request failed\nCaused by: [ECONNRESET] Connection reset by peer");
  expect(text).not.toContain("PRIVATE");
  expect(upstreamDiagnostic(diagnostic.upstream)).toBe(diagnostic.upstream);
  expect(
    upstreamDiagnostic({ code: "invalid_request_error", message: "Missing call_id" }),
  ).toContain("[invalid_request_error] Missing call_id");
  expect(
    upstreamDiagnostic(Object.assign(new TypeError("Invalid response"), { status: 502 })),
  ).toBe("[TypeError] [HTTP 502] Invalid response");
  Object.assign(error, { cause: error });
  expect(upstreamDiagnostic(error)).toBe("Request failed");
});

test.each([
  ["Authorization: Bearer sensitive-value", "sensitive-value"],
  ["Cookie: first=secret-one; second=secret-two", "secret-two"],
  ['{"refresh_token":"sensitive-value","error":"invalid_grant"}', "sensitive-value"],
  ["api_key=sensitive-value", "sensitive-value"],
  ['{"password":"secret with spaces"}', "secret with spaces"],
  ["Contact work@example.com", "work@example.com"],
  ["Fetch https://user:pass@example.com/path?key=secret-value#secret", "secret-value"],
  ["Key sk-not-a-real-key", "sk-not-a-real-key"],
  ["Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature", "eyJhbGci"],
])("redacts sensitive material in %s", (text, secret) => {
  const output = sanitizeDiagnostic(`Upstream rejected request. ${text}`);
  expect(output).toContain("Upstream rejected request.");
  expect(output).not.toContain(secret);
  expect(sanitizeDiagnostic(output)).toBe(output);
});

test("known credential and header values are redacted even when unlabeled or encoded", () => {
  const secrets = diagnosticSecrets(
    { type: "oauth", access: "plain-access", refresh: "refresh/with?chars", id_token: "id-secret" },
    { apiKey: "explicit-key", headers: { "x-custom-secret": "custom-header-value" } },
  );
  const output = sanitizeDiagnostic(
    "Rejected plain-access refresh%2Fwith%3Fchars id-secret explicit-key custom-header-value",
    secrets,
  );
  for (const secret of secrets) expect(output).not.toContain(secret);
  expect(output).not.toContain("refresh%2Fwith%3Fchars");
  expect(output).toContain("Rejected");
  expect(sanitizeDiagnostic('Value secret\\"escaped', ['secret"escaped'])).not.toContain("escaped");
});

test("diagnostics are bounded and terminal-safe", () => {
  expect(sanitizeDiagnostic("\x1b[31mBad\x1b[0m\r\x00\u202e request")).toBe("Bad request");
  expect(sanitizeDiagnostic("Bad\x1b]8;;https://secret.invalid\x07 link\x1b]8;;\x07")).toBe(
    "Bad link",
  );
  expect(sanitizeDiagnostic("failure details ".repeat(500)).length).toBeLessThanOrEqual(2000);
  expect(sanitizeDiagnostic("secret-token=" + "x".repeat(40_000))).toBe(
    "[Oversized upstream error omitted]",
  );
  expect(upstreamDiagnostic(undefined)).toContain("No upstream error details");
});

test("sanitized diagnostics survive reopen/compaction but never enter LLM context", () => {
  const directory = mkdtempSync(join(tmpdir(), "router-diagnostics-"));
  try {
    const session = SessionManager.create(directory, directory);
    session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "test",
      model: "model",
      content: [],
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
    const first = session.appendCustomEntry(DIAGNOSTIC_ENTRY, {
      ...diagnostic,
      upstream: sanitizeDiagnostic(`${diagnostic.upstream}. Bearer secret-token`),
    });
    session.appendCompaction("summary", first, 100);
    const reopened = SessionManager.open(session.getSessionFile()!);
    const records = sessionDiagnostics(reopened.getBranch());
    expect(records).toHaveLength(1);
    expect(formatDiagnostics(records)).toContain(diagnostic.upstream);
    expect(formatDiagnostics(records)).toContain("HTTP 400");
    expect(readFileSync(session.getSessionFile()!, "utf8")).not.toContain("secret-token");
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(
      diagnostic.upstream,
    );
    for (let i = 0; i < 15; i++)
      reopened.appendCustomEntry(DIAGNOSTIC_ENTRY, { ...diagnostic, timestamp: i + 2000 });
    reopened.appendCustomEntry(DIAGNOSTIC_ENTRY, { upstream: "malformed" });
    expect(sessionDiagnostics(reopened.getBranch())).toHaveLength(10);
    expect(sessionDiagnostics(reopened.getBranch())[0]?.timestamp).toBe(2005);
    reopened.branch(first);
    expect(sessionDiagnostics(reopened.getBranch())).toHaveLength(1);
    expect(formatDiagnostics(sessionDiagnostics(SessionManager.inMemory().getBranch()))).toContain(
      "No router failures",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
