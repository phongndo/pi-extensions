import { expect, spyOn, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { allowanceRows, countdown } from "../presentation.ts";
import { fromCodex } from "../allowances.ts";
import { UsageDashboard } from "../dashboard.ts";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { AllowanceSnapshot } from "../allowances.ts";
const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s } as Theme;

test("three banked resets add one compact countdown row, not repeated titles, timestamps or IDs", () => {
  const now = Date.UTC(2026, 8, 9);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const snapshot: AllowanceSnapshot = {
      account: { id: "fake", credentialId: "fake", provider: "openai-codex", name: "Personal" },
      checkedAt: now,
      allowances: [],
      availableResets: 3,
      resets: [11 * 1440 + 23 * 60, 25 * 1440 + 16, 26 * 1440 + 2 * 60].map((minutes, i) => ({
        id: `RateLimitResetCredit_${"x".repeat(40)}${i}`,
        title: "Full reset",
        status: "available",
        expiresAt: now + minutes * 60000,
      })),
    };
    const rows = allowanceRows([snapshot], 92, theme);
    const baseline = allowanceRows(
      [{ ...snapshot, resets: undefined, availableResets: undefined }],
      92,
      theme,
    );
    expect(rows.length - baseline.length).toBe(1);
    expect(rows.join("\n").replace(/ +/g, " ")).toContain(
      "Banked resets 3 available ◷ 11d 23h · 25d 16m · 26d 2h",
    );
    expect(rows.join("\n")).not.toContain("RateLimitResetCredit_");
    expect(rows.join("\n")).not.toContain("Full reset");
    expect(rows.join("\n")).not.toContain("Expires 2026");
  } finally {
    clock.mockRestore();
  }
});

test("screenshot-sized three-provider dashboard fits in twenty lines without verbose scaffolding", () => {
  const now = Date.UTC(2026, 8, 9);
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const account = (id: string, provider: string) => ({
      id,
      name: id,
      provider,
      credentialId: id,
    });
    const codex = fromCodex({
      account: account("personal", "openai-codex"),
      checkedAt: now,
      plan: "self_serve_business_prolite",
      windows: [
        { label: "Weekly", usedPercent: 51, resetsAt: now + 6 * 86400000 },
        { label: "GPT-5.3-Codex-Spark · 5-hour", usedPercent: 0, resetsAt: now + 5 * 3600000 },
        { label: "GPT-5.3-Codex-Spark · Weekly", usedPercent: 0, resetsAt: now + 7 * 86400000 },
      ],
      availableResets: 3,
      creditBalance: "0",
      resets: [12, 25, 26].map((days) => ({
        id: "RateLimitResetCredit_" + "x".repeat(45),
        title: "Full reset",
        status: "available",
        expiresAt: now + days * 86400000,
      })),
    });
    const snapshots: AllowanceSnapshot[] = [
      {
        account: account("Team", "firecrawl"),
        checkedAt: now,
        allowances: [
          {
            label: "Team credits",
            remaining: 3633,
            unit: "credits",
            resetsAt: now + 15 * 86400000,
            resetLabel: "Billing period ends",
          },
        ],
      },
      codex,
      {
        ...codex,
        account: account("work", "openai-codex"),
        allowances: codex.allowances.slice(0, 1),
        availableResets: 2,
        resets: codex.resets!.slice(0, 2),
      },
      {
        account: account("Account 1", "xai"),
        checkedAt: 0,
        allowances: [],
        unavailable: "Grok quota reader not implemented",
        unsupported: true,
      },
    ];
    const view = new UsageDashboard(
      [],
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      () => {},
      () => 80,
      { snapshots },
    );
    const rows = view.render(100);
    const text = rows.join("\n");
    expect(rows.length).toBeLessThanOrEqual(20);
    for (const label of [
      "personal",
      "work",
      "49%",
      "Spark 5h",
      "Spark Weekly",
      "3,633 credits",
      "3 available",
      "2 available",
      "Not supported yet",
    ])
      expect(text).toContain(label);
    expect(rows.filter((row) => row.includes("━")).length).toBe(4);
    for (const clutter of [
      "RateLimitResetCredit",
      "Checked",
      "self_serve",
      "Extra credits",
      "Full reset",
      "2026-",
      "Live · read-only",
    ])
      expect(text).not.toContain(clutter);
  } finally {
    clock.mockRestore();
  }
});

test("countdowns are short without making unknown or sub-minute expirations zero", () => {
  const now = 100000000;
  expect(countdown(undefined, now)).toBe("unknown");
  expect(countdown(NaN, now)).toBe("unknown");
  expect(countdown(now, now)).toBe("expired");
  expect(countdown(now + 30000, now)).toBe("<1m");
  expect(countdown(now + 61 * 60000, now)).toBe("1h 1m");
});
