import { expect, test } from "bun:test";
import { codexAccountId, parseBankedResets, parseCodexUsage, readCodexSnapshot } from "../codex.ts";
import { codexLines } from "../dashboard.ts";
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url")}.signature`;
const account = { id: "native:openai-codex", name: "Account 1", credentialId: "openai-codex" };
const usage = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 50, limit_window_seconds: 604800, reset_at: 1800100000 },
  },
  credits: { balance: "5.25" },
};
const resets = {
  available_count: 1,
  credits: [
    {
      id: "first",
      title: "Promo",
      reset_type: "weekly",
      status: "available",
      granted_at: "2026-09-01T00:00:00Z",
      expires_at: "2026-09-10T00:00:00Z",
    },
    { id: "second", reset_type: "weekly", status: "consumed", expires_at: "2026-09-20T00:00:00Z" },
    { id: "third", reset_type: "weekly", status: "expired", expires_at: null },
  ],
};
function fetcher(
  fn: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return fn as typeof fetch;
}
test("normal usage has primary/weekly and additional windows; banked resets retain every status and expiration", () => {
  const parsed = parseCodexUsage({
    ...usage,
    additional_rate_limits: [{ limit_name: "Extra", rate_limit: usage.rate_limit }],
  });
  expect(parsed.windows).toHaveLength(4);
  expect(parsed.windows?.slice(0, 2).map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
  expect(parsed.windows?.[0]?.resetsAt).toBe(1800000000000);
  expect(parsed.creditBalance).toBe("5.25");
  const banked = parseBankedResets(resets);
  expect(banked.availableResets).toBe(1);
  expect(banked.resets).toHaveLength(3);
  expect(banked.resets?.[2]?.expiresAt).toBeUndefined();
  const lines = codexLines([{ account, checkedAt: 1800000000000, ...parsed, ...banked }]).join(
    "\n",
  );
  for (const text of [
    "88% remaining",
    "50% remaining",
    "2026-09-10",
    "2026-09-20",
    "[consumed]",
    "[expired]",
    "expires unknown",
    "not banked resets",
  ])
    expect(lines).toContain(text);
});
test("GET-only reads use native account headers, official host and redirect rejection", async () => {
  const requests: string[] = [];
  const result = await readCodexSnapshot(
    account,
    async () => token,
    new AbortController().signal,
    fetcher((url, init) => {
      requests.push(url);
      expect(url.startsWith("https://chatgpt.com/backend-api/wham/")).toBe(true);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual({
        Authorization: `Bearer ${token}`,
        "ChatGPT-Account-Id": "account-123",
        Accept: "application/json",
      });
      expect(init?.body).toBeUndefined();
      return Response.json(url.endsWith("/usage") ? usage : resets);
    }),
  );
  expect(requests.map((url) => url.split("/").at(-1)).sort()).toEqual([
    "rate-limit-reset-credits",
    "usage",
  ]);
  expect(result.usageError).toBeUndefined();
  expect(result.resetsError).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(token);
});
test("independent failures display unavailable, never a fabricated zero or leaked body", async () => {
  const result = await readCodexSnapshot(
    account,
    async () => token,
    new AbortController().signal,
    fetcher((url) =>
      url.endsWith("/usage")
        ? Response.json(usage)
        : new Response("SECRET billing error", { status: 403 }),
    ),
  );
  expect(result.windows).toHaveLength(2);
  expect(result.availableResets).toBeUndefined();
  expect(result.resetsError).toBe("Banked resets unavailable");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  for (const value of [
    {},
    { available_count: -1, credits: [] },
    { available_count: 1, credits: [{}] },
    { ...resets, credits: [{ ...resets.credits[0], expires_at: "not a date" }] },
  ])
    expect(() => parseBankedResets(value)).toThrow();
  expect(parseBankedResets({ available_count: 0, credits: [] })).toEqual({
    availableResets: 0,
    resets: [],
  });
  expect(() => parseCodexUsage({})).toThrow();
});
test("missing/invalid tokens, refresh exceptions, cancellation and oversized responses are safe", async () => {
  let calls = 0;
  const noRequest = fetcher(() => {
    calls++;
    throw new Error("Unexpected network");
  });
  for (const value of [undefined, "bad", "h.e30.s", "h." + "a".repeat(33000) + ".s"]) {
    const result = await readCodexSnapshot(
      account,
      async () => value,
      new AbortController().signal,
      noRequest,
    );
    expect(result.usageError).toContain("unavailable");
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await readCodexSnapshot(account, async () => token, cancelled.signal, noRequest);
  const failed = await readCodexSnapshot(
    account,
    async () => {
      throw new Error("SECRET refresh");
    },
    new AbortController().signal,
    noRequest,
  );
  expect(JSON.stringify(failed)).not.toContain("SECRET");
  expect(calls).toBe(0);
  expect(codexAccountId(token)).toBe("account-123");
  const huge = await readCodexSnapshot(
    account,
    async () => token,
    new AbortController().signal,
    fetcher(() => new Response("x".repeat(1024 * 1024 + 1))),
  );
  expect(huge.usageError).toBe("Live usage unavailable");
  expect(huge.resetsError).toBe("Banked resets unavailable");
});
test("untrusted labels are stripped of terminal controls", () => {
  const result = parseBankedResets({
    ...resets,
    credits: [{ ...resets.credits[0], title: "evil\u001b[31m\nname" }],
  });
  expect(result.resets?.[0]?.title).not.toContain("\u001b");
  expect(result.resets?.[0]?.title).not.toContain("\n");
});
