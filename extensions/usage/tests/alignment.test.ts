import { expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AllowanceSnapshot } from "../allowances.ts";
import { allowanceRows } from "../presentation.ts";
const theme = {
  fg: (_: string, s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
} as Theme;

test("left-anchored columns align across providers and never move when account or limit names change", () => {
  const now = Date.now();
  const snapshots: AllowanceSnapshot[] = [
    {
      account: { id: "a", name: "personal", provider: "openai-codex", credentialId: "a" },
      checkedAt: now,
      allowances: [
        { label: "Weekly", remainingPercent: 48, resetsAt: now + 86400000 },
        { label: "Spark Weekly", remainingPercent: 100, resetsAt: now + 86400000 },
      ],
      availableResets: 1,
      resets: [
        { id: "hidden", title: "Full reset", status: "available", expiresAt: now + 86400000 },
      ],
    },
    {
      account: { id: "b", name: "Account 1", provider: "xai", credentialId: "b" },
      checkedAt: now,
      allowances: [{ label: "Credits", remainingPercent: 67, resetsAt: now + 86400000 }],
    },
    {
      account: { id: "c", name: "Team", provider: "firecrawl", credentialId: "c" },
      checkedAt: now,
      allowances: [
        {
          label: "Team credits",
          shortLabel: "",
          remaining: 3626,
          unit: "credits",
          resetsAt: now + 86400000,
          resetLabel: "Billing period ends",
        },
      ],
    },
  ];
  const render = (data: AllowanceSnapshot[]) =>
    allowanceRows(data, 92, theme).map(stripVTControlCharacters);
  const offsets = (rows: string[]) =>
    rows
      .filter((row) => /[━─]/.test(row))
      .map((row) => ({
        bar: row.search(/[━─]/),
        percent: row.indexOf("%"),
        reset: row.indexOf("↻"),
      }));
  const rows = render(snapshots);
  const original = offsets(rows);
  expect(new Set(original.map((value) => JSON.stringify(value))).size).toBe(1);
  const renamed = render(
    snapshots.map((s, i) => ({
      ...s,
      account: {
        ...s.account,
        name: i ? "X" : "A very long account alias that should not move bars",
      },
      allowances: s.allowances.map((a) => ({
        ...a,
        label: "An extremely long window name that should not move bars",
      })),
    })),
  );
  expect(offsets(renamed)).toEqual(original);
  const banked = rows.find((row) => row.includes("Banked resets"))!;
  const weekly = rows.find((row) => row.includes("Weekly"))!;
  expect(banked.indexOf("Banked resets")).toBe(weekly.indexOf("Weekly"));
  expect(banked.indexOf("1 available")).toBe(original[0]!.bar);
  expect(banked.indexOf("◷")).toBe(original[0]!.reset);
  const credits = rows.find((row) => row.includes("3,626 credits"))!;
  expect(credits.indexOf("3,626 credits")).toBe(original[0]!.bar);
  expect(credits.indexOf("ends")).toBe(original[0]!.reset);
});
