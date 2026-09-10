import { expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { liveRows, providerName, remainingUsage } from "../presentation.ts";
import { codexLines } from "../dashboard.ts";
const theme = {
  fg: (_color: string, text: string) => `\u001b[36m${text}\u001b[0m`,
  bold: (text: string) => text,
} as Theme;
test("friendly provider labels", () => {
  expect(providerName("openai-codex")).toBe("OpenAI Codex");
  expect(providerName("xai")).toBe("Grok");
  expect(providerName("custom-id", new Map([["custom-id", "My server"]]))).toBe("My server");
  expect(providerName("other-provider")).toBe("other-provider");
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
