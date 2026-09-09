import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { estimate, liveRows, providerName, remainingUsage, table } from "../presentation.ts";
import { codexLines } from "../dashboard.ts";
const theme = {
  fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  bold: (text: string) => text,
} as Theme;
test("aligned usage columns, friendly provider labels, compact but honest currency", () => {
  expect(providerName("openai-codex")).toBe("OpenAI Codex");
  expect(providerName("xai")).toBe("Grok");
  expect(providerName("custom-id", new Map([["custom-id", "My server"]]))).toBe("My server");
  expect(providerName("other-provider")).toBe("other-provider");
  expect([0, 0.000001, 0.0123, 12.34].map(estimate)).toEqual(["$0", "<$0.01", "$0.01", "$12.34"]);
  const rows = [
    { label: "OpenAI Codex", accounts: "2", tokens: "12K", estimate: "$0" },
    { label: "xAI", accounts: "1", tokens: "8K", estimate: "$0.25" },
  ];
  const rendered = table(rows, "Providers", 80, 5, theme, 0).map(stripVTControlCharacters);
  expect(rendered[1]).toStartWith("› OpenAI Codex");
  expect(rendered[1]!.indexOf("12K") + 3).toBe(rendered[2]!.indexOf("8K") + 2);
  expect(rendered[1]!.endsWith("$0")).toBe(true);
  expect(rendered[2]!.endsWith("$0.25")).toBe(true);
});
test("tables preserve selected rows, respect height, and shed optional columns at small widths", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    label: `Row ${i} 測試`,
    tokens: "1K",
    estimate: "$0.25",
    accounts: "2",
  }));
  for (const width of [1, 20, 40, 80, 120])
    for (const room of [0, 1, 2, 3, 5, 10]) {
      const lines = table(rows, "Providers", width, room, theme, 24);
      expect(lines.length).toBeLessThanOrEqual(room);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 20 && room >= 2) expect(lines.join("\n")).toContain("Row 24");
    }
  expect(table(rows, "Providers", 40, 5, theme).join("\n")).not.toContain("Price eq.");
  expect(table(rows, "Providers", 60, 5, theme).join("\n")).not.toContain("Accounts");
});
test("remaining allowance stays bounded, distinguishes unavailable, and agrees between TUI and RPC", () => {
  expect(remainingUsage(0)).toEqual({ percent: 100, label: "100% remaining" });
  expect(remainingUsage(38)).toEqual({ percent: 62, label: "62% remaining" });
  expect(remainingUsage(99.7).label).toBe("0.3% remaining");
  expect(remainingUsage(99.999).label).toBe("<0.01% remaining");
  for (const used of [100, 120])
    expect(remainingUsage(used)).toEqual({ percent: 0, label: "0% remaining" });
  for (const used of [-1, NaN, Infinity])
    expect(remainingUsage(used)).toEqual({ label: "Remaining unavailable" });
  const snapshot = {
    account: { id: "a", name: "Work", credentialId: "fake" },
    checkedAt: 0,
    windows: [{ label: "5-hour", usedPercent: 38, resetsAt: Date.UTC(2026, 8, 9) }],
  };
  const text = stripVTControlCharacters(liveRows([snapshot], 92, theme).join("\n"));
  expect(text).toContain("62%");
  expect(text).toContain("━".repeat(7) + "─".repeat(5));
  expect(text).not.toContain("38% used");
  expect(codexLines([snapshot]).join("\n")).toContain("62% remaining · resets 2026-09-09");
});
test("compact limits omit raw plans and IDs while retaining reset countdowns and unavailable states", () => {
  const data = [
    {
      account: { id: "a", name: "Work", credentialId: "fake" },
      checkedAt: Date.UTC(2026, 8, 8),
      plan: "Plus",
      windows: [
        { label: "5-hour", usedPercent: 45, resetsAt: Date.UTC(2026, 8, 9) },
        { label: "Code review · Weekly extra window", usedPercent: 120 },
      ],
      availableResets: 1,
      creditBalance: "10",
      resets: [
        {
          id: "banked-1",
          title: "Promotion",
          status: "available",
          expiresAt: Date.UTC(2026, 10, 1),
        },
        { id: "banked-2", title: "Old", status: "consumed" },
      ],
    },
  ];
  const clock = spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 8));
  const rendered = stripVTControlCharacters(liveRows(data, 92, theme).join("\n"));
  clock.mockRestore();
  for (const value of [
    "Work",
    "55%",
    "0%",
    "Code review W…",
    "↻ 1d",
    "Banked resets 1 available ◷ 54d",
    "1 consumed ◷ unknown",
    "Extra credits 10",
  ])
    expect(rendered.replace(/ +/g, " ")).toContain(value);
  expect(codexLines(data).join("\n")).toContain("Code review · Weekly extra window");
  expect(rendered).toContain("━");
  for (const clutter of ["Plus", "banked-1", "banked-2", "2026-", "Checked"])
    expect(rendered).not.toContain(clutter);
  for (const width of [1, 20, 40, 92])
    expect(liveRows(data, width, theme).every((line) => visibleWidth(line) <= width)).toBe(true);
  const failed = stripVTControlCharacters(
    liveRows(
      [{ ...data[0]!, usageError: "Usage unavailable", resetsError: "Resets unavailable" }],
      92,
      theme,
    ).join("\n"),
  );
  expect(failed).toContain("Unavailable");
  expect(failed.replace(/ +/g, " ")).toContain("Banked resets Unavailable");
  expect(failed).not.toContain("55% remaining");
  expect(failed).not.toContain("banked-1");
});
