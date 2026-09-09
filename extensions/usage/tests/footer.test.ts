import { expect, test, spyOn } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { UsageFooter, formatUsageFooter } from "../footer.ts";
import type { AllowanceSnapshot } from "../allowances.ts";
import { setFooterStatus } from "../../../src/footer-status.ts";
import { createUsageExtension } from "../index.ts";
import * as live from "../live.ts";

const snapshot = (id = "native:xai", percent = 72): AllowanceSnapshot => ({
  account: { id, provider: "xai", name: "Personal", credentialId: "xai" },
  checkedAt: 1000,
  allowances: [
    { label: "5-hour", shortLabel: "5h", remainingPercent: percent },
    { label: "Weekly", remainingPercent: 45 },
  ],
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const harness = () => {
  const statuses = new Map<string, string | undefined>();
  const ctx = {
    hasUI: true,
    sessionManager: {},
    ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
  } as unknown as ExtensionContext;
  return { ctx, statuses };
};

test("compact footer preserves reported windows, zero, unknown, units and expired resets", () => {
  expect(formatUsageFooter(snapshot())).toBe("remaining 5h 72% · remaining weekly 45%");
  expect(
    formatUsageFooter({ ...snapshot(), allowances: [{ label: "Credits", remainingPercent: 0 }] }),
  ).toBe("remaining 0%");
  expect(formatUsageFooter({ ...snapshot(), allowances: [{ label: "Credits" }] })).toBe(
    "remaining ?",
  );
  expect(
    formatUsageFooter({
      ...snapshot(),
      allowances: [{ label: "Team", remaining: 500, unit: "credits" }],
    }),
  ).toBe("remaining 500 credits");
  expect(
    formatUsageFooter(
      { ...snapshot(), allowances: [{ label: "5h", remainingPercent: 99, resetsAt: 500 }] },
      1000,
    ),
  ).toBe("remaining ?");
  expect(formatUsageFooter({ ...snapshot(), unsupported: true })).toBe("usage unsupported");
  expect(formatUsageFooter({ ...snapshot(), unavailable: "secret error" })).toBe(
    "usage unavailable",
  );
});

test("Spark is hidden and only multiple regular windows need labels", () => {
  const sparks = [
    { label: "GPT-5.3-Codex-Spark · 5-hour", shortLabel: "Spark 5h", remainingPercent: 100 },
    { label: "Spark Weekly", remainingPercent: 100 },
  ];
  const single = {
    ...snapshot(),
    allowances: [{ label: "Weekly", remainingPercent: 41 }, ...sparks],
  };
  expect(formatUsageFooter(single)).toBe("remaining 41%");
  expect(single.allowances).toHaveLength(3); // Dashboard keeps all limits.
  expect(
    formatUsageFooter({
      ...single,
      allowances: [...single.allowances, { label: "5-hour", remainingPercent: 72 }],
    }),
  ).toBe("remaining weekly 41% · remaining 5h 72%");
  expect(formatUsageFooter({ ...single, allowances: sparks })).toBe("usage unavailable");
});

test("native status coexists with MCP/router, throttles refreshes, and clears on disable/shutdown", async () => {
  const { ctx, statuses } = harness();
  let now = 1000;
  let enabled = true;
  let reads = 0;
  const footer = new UsageFooter(
    async () => {
      reads++;
      return snapshot();
    },
    () => enabled,
    () => now,
  );
  setFooterStatus(ctx, "mcp", "mcp 2");
  setFooterStatus(ctx, "router", "route Personal");
  footer.update(ctx, "native:xai");
  expect(statuses.get("usage")).toBe("· usage …");
  await settle();
  expect(statuses.get("usage")).toBe("· remaining 5h 72% · remaining weekly 45%");
  expect(statuses.get("router")).toBe("· route Personal");
  footer.update(ctx, "native:xai");
  expect(reads).toBe(1);
  now += 60_000;
  footer.update(ctx, "native:xai");
  await settle();
  expect(reads).toBe(2);
  footer.update(ctx, "native:xai", true);
  await settle();
  expect(reads).toBe(3);
  enabled = false;
  footer.update(ctx, "native:xai");
  expect(statuses.get("usage")).toBeUndefined();
  expect(statuses.get("mcp")).toBe("mcp 2");
  enabled = true;
  footer.update(ctx, "native:xai");
  footer.close();
  await settle();
  expect(statuses.get("usage")).toBeUndefined();
  footer.update(ctx, "native:xai");
  expect(reads).toBe(4);
});

test("account switches cancel reads; late responses and shutdown never restore stale status", async () => {
  const { ctx, statuses } = harness();
  const requests: { id: string; signal: AbortSignal; resolve: (s: AllowanceSnapshot) => void }[] =
    [];
  const footer = new UsageFooter(
    async (_ctx, id, signal) =>
      new Promise((resolve) => {
        requests.push({ id, signal, resolve });
      }),
    () => true,
  );
  footer.update(ctx, "a");
  footer.update(ctx, "b");
  expect(requests[0]!.signal.aborted).toBe(true);
  requests[1]!.resolve(snapshot("b", 20));
  await settle();
  expect(statuses.get("usage")).toContain("20%");
  requests[0]!.resolve(snapshot("a", 90));
  await settle();
  expect(statuses.get("usage")).not.toContain("90%");
  footer.update(ctx, "c");
  footer.close();
  expect(requests[2]!.signal.aborted).toBe(true);
  requests[2]!.resolve(snapshot("c"));
  await settle();
  expect(statuses.get("usage")).toBeUndefined();
});

test("failed refresh clears old numbers; dashboard snapshots replace pending reads", async () => {
  const { ctx, statuses } = harness();
  let fail = false;
  const footer = new UsageFooter(
    async () => {
      if (fail) throw new Error("private token");
      return snapshot();
    },
    () => true,
  );
  footer.update(ctx, "native:xai");
  await settle();
  fail = true;
  footer.update(ctx, "native:xai", true);
  await settle();
  expect(statuses.get("usage")).toBe("usage unavailable");
  footer.accept([snapshot("other", 90)]);
  expect(statuses.get("usage")).toBe("usage unavailable");
  footer.accept([snapshot("native:xai", 50)]);
  expect(statuses.get("usage")).toContain("50%");
  footer.update(ctx, undefined);
  expect(statuses.get("usage")).toBeUndefined();
  footer.close();
});

test("extension follows routed defaults/fallbacks and native models through native status API", async () => {
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "0";
  const loaded: string[] = [];
  const mock = spyOn(live, "loadLiveUsage").mockImplementation(async (_ctx, _signal, options) => {
    loaded.push(options!.accountId!);
    return {
      accounts: [],
      snapshots: [snapshot(options!.accountId!, options!.accountId === "b" ? 20 : 72)],
    };
  });
  const events = createEventBus();
  const hooks = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const { ctx, statuses } = harness();
  const model = { provider: "accounts-xai" };
  Object.assign(ctx, {
    model,
    modelRegistry: {
      getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
      isUsingOAuth: () => true,
    },
  });
  createUsageExtension()({
    events,
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI);
  try {
    hooks.get("session_start")!({}, ctx);
    expect(loaded).toEqual([]); // Never guess a routed account.
    events.emit("router:active-account", { id: "a", provider: "xai" });
    await settle();
    expect(loaded).toEqual(["a"]);
    expect(statuses.get("usage")).toContain("72%");
    events.emit("router:active-account", { id: "b", provider: "xai" });
    await settle();
    expect(statuses.get("usage")).toContain("20%");
    hooks.get("agent_end")!({}, ctx);
    await settle();
    expect(loaded).toEqual(["a", "b", "b"]);
    model.provider = "xai";
    hooks.get("model_select")!({}, ctx);
    await settle();
    expect(loaded.at(-1)).toBe("native:xai");
    Object.assign(ctx.modelRegistry, { isUsingOAuth: () => false });
    hooks.get("model_select")!({}, ctx);
    expect(statuses.get("usage")).toBeUndefined();
    hooks.get("session_shutdown")!({}, ctx);
    const count = loaded.length;
    events.emit("router:active-account", { id: "a", provider: "xai" });
    expect(loaded).toHaveLength(count);
  } finally {
    hooks.get("session_shutdown")!({}, ctx);
    mock.mockRestore();
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});
