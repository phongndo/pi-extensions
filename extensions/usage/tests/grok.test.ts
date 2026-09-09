import { expect, test } from "bun:test";
import { parseGrokUsage, readAllowance } from "../allowances.ts";

test("Grok credits parse CodexBar's verified proxy shape without inventing subscription balances", () => {
  const window = parseGrokUsage({
    config: {
      creditUsagePercent: 37.5,
      currentPeriod: { end: "2026-10-01T00:00:00Z" },
      billingPeriodEnd: "2026-11-01T00:00:00Z",
    },
  })[0]!;
  expect(window.remainingPercent).toBe(62.5);
  expect(window.resetsAt).toBe(Date.UTC(2026, 9, 1));
  expect(parseGrokUsage({ config: { creditUsagePercent: 0 } })[0]?.remainingPercent).toBe(100);
  expect(parseGrokUsage({ config: { creditUsagePercent: 120 } })[0]?.remainingPercent).toBe(0);
  const periodOnly = parseGrokUsage({
    config: {
      currentPeriod: { end: "bad" },
      billingPeriodEnd: "2026-10-01T00:00:00Z",
      onDemandUsed: { val: 0 },
      onDemandCap: { val: 100 },
    },
  })[0]!;
  expect(periodOnly.remainingPercent).toBeUndefined(); // on-demand spending cap is not the subscription denominator
  expect(periodOnly.resetsAt).toBe(Date.UTC(2026, 9, 1));
  for (const value of [
    null,
    {},
    { config: [] },
    { config: {} },
    ...[-1, NaN, Infinity, "50"].map((creditUsagePercent) => ({ config: { creditUsagePercent } })),
  ])
    expect(() => parseGrokUsage(value)).toThrow();
});

test("Grok reader uses a single read-only billing GET with Pi's resolved token; no CLI, cookies or management API", async () => {
  let calls = 0;
  let resolved = 0;
  const account = { id: "native:xai", provider: "xai", credentialId: "xai", name: "Personal" };
  const result = await readAllowance(
    account,
    async () => {
      resolved++;
      return "fake-native-token";
    },
    new AbortController().signal,
    (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({
        Authorization: "Bearer fake-native-token",
        Accept: "application/json",
        "x-xai-token-auth": "xai-grok-cli",
      });
      return Response.json({ config: { creditUsagePercent: 30 } });
    }) as typeof fetch,
  );
  expect(calls).toBe(1);
  expect(resolved).toBe(1);
  expect(result.allowances[0]?.remainingPercent).toBe(70);
  expect(result.unsupported).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("fake-native-token");
  const failed = await readAllowance(
    account,
    async () => "fake-native-token",
    new AbortController().signal,
    (async () =>
      new Response("fake-native-token sensitive-provider-error", { status: 403 })) as typeof fetch,
  );
  expect(failed.unavailable).toContain("unavailable");
  expect(JSON.stringify(failed)).not.toContain("fake-native-token");
  expect(JSON.stringify(failed)).not.toContain("sensitive-provider-error");
});
