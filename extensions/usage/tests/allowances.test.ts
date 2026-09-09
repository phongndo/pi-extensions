import { expect, test } from "bun:test";
import {
  allowanceAdapters,
  parseFirecrawlUsage,
  readAllowance,
  type AllowanceAdapter,
} from "../allowances.ts";
import { allowanceLabel } from "../presentation.ts";
import { allowanceLines } from "../dashboard.ts";
const account = (provider: string) => ({
  id: provider,
  provider,
  name: "Work",
  credentialId: provider,
});
const signal = () => new AbortController().signal;

test("Firecrawl credits are exact team credits, never an invented plan percentage", () => {
  const [allowance] = parseFirecrawlUsage({
    success: true,
    data: {
      remainingCredits: 600001,
      planCredits: 500000,
      billingPeriodEnd: "2026-10-01T00:00:00Z",
    },
  });
  expect(allowance?.remaining).toBe(600001);
  expect(allowance?.remainingPercent).toBeUndefined();
  expect(allowance?.resetsAt).toBe(Date.UTC(2026, 9, 1));
  expect(allowance?.resetLabel).toBe("Billing period ends");
  expect(allowanceLabel(allowance!)).toBe("600,001 credits remaining");
  expect(parseFirecrawlUsage({ success: true, data: { remainingCredits: 0 } })[0]?.remaining).toBe(
    0,
  );
  for (const value of [
    null,
    {},
    { success: false, data: { remainingCredits: 0 } },
    ...[-1, Infinity, "50", undefined].map((remainingCredits) => ({
      success: true,
      data: { remainingCredits },
    })),
  ])
    expect(() => parseFirecrawlUsage(value)).toThrow();
});

test("status adapters use GET-only official paths, reject redirects, and redact all failures", async () => {
  let calls = 0;
  const fetcher = (async (url: string, init: RequestInit) => {
    calls++;
    expect(url).toBe("https://api.firecrawl.dev/v2/team/credit-usage");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({
      Authorization: "Bearer fake-secret",
      Accept: "application/json",
    });
    return Response.json({ success: true, data: { remainingCredits: 1234 } });
  }) as typeof fetch;
  const result = await readAllowance(
    account("firecrawl"),
    async () => "fake-secret",
    signal(),
    fetcher,
  );
  expect(result.allowances[0]?.remaining).toBe(1234);
  expect(allowanceLines([result]).join("\n")).toContain("1,234 credits remaining");
  expect(JSON.stringify(result)).not.toContain("fake-secret");
  expect(calls).toBe(1);
  for (const response of [
    new Response("fake-secret provider-error", { status: 403 }),
    new Response("bad json"),
    Response.json({ success: false, error: "fake-secret" }),
    new Response("x".repeat(1024 * 1024 + 1)),
    new Response("", { headers: { "content-length": String(1024 * 1024 + 1) } }),
  ]) {
    const failed = await readAllowance(
      account("firecrawl"),
      async () => "fake-secret",
      signal(),
      (async () => response) as typeof fetch,
    );
    expect(failed.allowances).toEqual([]);
    expect(failed.unavailable).toContain("unavailable");
    expect(JSON.stringify(failed)).not.toContain("fake-secret");
  }
  const abort = new AbortController();
  abort.abort();
  await readAllowance(
    account("firecrawl"),
    async () => {
      throw new Error("must not resolve");
    },
    abort.signal,
    fetcher,
  );
  expect(calls).toBe(1);
});

test("future unsupported subscriptions remain visible without token refresh or probing", async () => {
  for (const provider of ["future-subscription", "anthropic", "kimi-coding", "github-copilot"]) {
    let resolved = false;
    const result = await readAllowance(
      account(provider),
      async () => {
        resolved = true;
        return "unused";
      },
      signal(),
      (async () => {
        throw new Error("no requests");
      }) as typeof fetch,
    );
    expect(resolved).toBe(false);
    expect(result.account.provider).toBe(provider);
    expect(result.allowances).toEqual([]);
    expect(result.unavailable).toBeDefined();
  }
  const future: AllowanceAdapter = {
    read: async (account) => ({
      account,
      checkedAt: 1,
      allowances: [{ label: "Monthly", unlimited: true }],
    }),
  };
  const registry = new Map([...allowanceAdapters, ["future-subscription", future] as const]);
  const result = await readAllowance(
    account("future-subscription"),
    async () => undefined,
    signal(),
    fetch,
    registry,
  );
  expect(allowanceLines([result]).join("\n")).toContain("Monthly: Unlimited");
});
