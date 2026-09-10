import { expect, test } from "bun:test";
import { safeLabel } from "../labels.ts";

test("display labels strip control, bidi and line separators while preserving Unicode", () => {
  expect(safeLabel("Work\n\t\u001b\u202e\u2028\u2029 測試")).toBe("Work 測試");
  expect(safeLabel("Personal · Weekly")).toBe("Personal · Weekly");
});
