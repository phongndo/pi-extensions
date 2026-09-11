import { expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseOpenCodeGoUsage, readAllowance } from "../allowances.ts";
import { loadLiveUsage } from "../live.ts";
import { formatUsageFooter } from "../footer.ts";

const payload = {
  usage: {
    rolling: { status: "ok", percent: 25, resetsAt: "2099-01-01T00:00:00Z" },
    weekly: { status: "rate-limited", percent: 105 },
    monthly: { status: "ok", percent: 0 },
  },
};

test("Go converts every used window to remaining; missing/invalid values stay unknown", () => {
  const values = parseOpenCodeGoUsage(payload);
  expect(values.map((v) => v.remainingPercent)).toEqual([75, 0, 100]);
  expect(values[0]?.resetsAt).toBe(Date.parse("2099-01-01T00:00:00Z"));
  for (const percent of [undefined, null, "25", -1, NaN, Infinity]) {
    expect(parseOpenCodeGoUsage({ usage: { rolling: { percent, resetsAt: "bad" } } })[0]).toEqual({
      label: "5h",
      remainingPercent: undefined,
      resetsAt: undefined,
    });
  }
  expect(() => parseOpenCodeGoUsage({})).toThrow();
});

test("Go uses native stored key before shared env, excludes Zen, and supports active-account reads", async () => {
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "fake-env";
  try {
    const credentials = new InMemoryCredentialStore();
    for (const id of ["opencode-go", "opencode"])
      await credentials.modify(id, async () => ({ type: "api_key", key: "fake-stored" }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    const ctx = { modelRegistry: new ModelRegistry(runtime) } as ExtensionContext;
    const headers: string[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
      expect(init.redirect).toBe("error");
      headers.push((init.headers as Record<string, string>).Authorization!);
      return Response.json(payload);
    }) as typeof fetch;
    const options = { credentials, modelsPath: null, fetcher, accountId: "native:opencode-go" };
    const a = await loadLiveUsage(ctx, new AbortController().signal, options);
    expect(a.accounts.map((a) => a.provider)).toEqual(["opencode-go"]);
    expect(formatUsageFooter(a.snapshots[0]!)).toBe(
      "remaining 5h 75% · remaining weekly 0% · remaining monthly 100%",
    );
    expect(JSON.stringify(a)).not.toContain("fake-stored");
    await credentials.delete("opencode-go");
    await loadLiveUsage(ctx, new AbortController().signal, options);
    expect(headers).toEqual(["Bearer fake-stored", "Bearer fake-env"]);
    delete process.env.OPENCODE_API_KEY;
    expect((await loadLiveUsage(ctx, new AbortController().signal, options)).accounts).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("Go auth, entitlement, malformed and network failures remain unavailable and redact secrets", async () => {
  const account = {
    id: "native:opencode-go",
    provider: "opencode-go",
    name: "Account 1",
    credentialId: "opencode-go",
  };
  for (const fetcher of [
    async () => new Response("secret", { status: 401 }),
    async () => new Response("secret", { status: 403 }),
    async () => Response.json({}),
    async () => {
      throw new Error("secret");
    },
  ]) {
    const result = await readAllowance(
      account,
      async () => "secret",
      new AbortController().signal,
      fetcher as typeof fetch,
    );
    expect(result.unavailable).toBeDefined();
    expect(result.allowances).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret");
  }
});
