import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RankingStore,
  rankAccounts,
  multipleAccounts,
  readLegacyAccounts,
  normalizeAlias,
} from "../store.ts";
import { nativeAccounts, parseLoginId, loginId } from "../../../src/account-identity.ts";
import type { Provider } from "@earendil-works/pi-ai";
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pi-router-test-"));
  dirs.push(dir);
  const path = join(dir, "router.json");
  return { path, store: new RankingStore(path) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("only private ranking metadata is written; concurrent changes to other providers merge", () => {
  const { path, store } = setup();
  expect(store.read()).toEqual({});
  store.save({ codex: ["two", "one"] }, {});
  new RankingStore(path).save({ anthropic: ["work", "home"] }, {});
  expect(store.read()).toEqual({ codex: ["two", "one"], anthropic: ["work", "home"] });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).not.toContain("credential");
  expect(() => store.save({ codex: ["one", "two"] }, {})).toThrow("another session");
});
test("corrupt and invalid metadata is not overwritten", () => {
  const { store, path } = setup();
  expect(() => store.save({ test: ["a", "a"] }, {})).toThrow();
  writeFileSync(path, "{broken");
  expect(() => store.save({ test: ["a"] }, {})).toThrow();
  expect(readFileSync(path, "utf8")).toBe("{broken");
});
test("aliases and rankings merge independently, save atomically, clear, and survive restarts", () => {
  const { path, store } = setup();
  writeFileSync(path, JSON.stringify({ version: 1, order: { codex: ["two", "one"] } }));
  expect(store.readAliases()).toEqual({});
  store.save({}, {}, { one: "  Personal 測試  " });
  const other = new RankingStore(path);
  other.save({ codex: ["one", "two"] }, { codex: ["two", "one"] });
  other.save({}, {}, { two: "Work" });
  expect(store.readAliases()).toEqual({ one: "Personal 測試", two: "Work" });
  expect(store.read()).toEqual({ codex: ["one", "two"] });
  const before = readFileSync(path, "utf8");
  expect(() => store.save({ codex: ["two", "one"] }, store.read(), { one: "Conflicting" })).toThrow(
    "Alias changed",
  );
  expect(readFileSync(path, "utf8")).toBe(before); // No partial ranking write on alias conflict.
  store.save({}, {}, { one: " " }, store.readAliases());
  expect(new RankingStore(path).readAliases()).toEqual({ two: "Work" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
test("aliases reject terminal controls and malformed metadata without overwriting", () => {
  const { path, store } = setup();
  for (const value of ["a\nb", "a\u001b[31m", "bad\u202etext", "a\u2028b", "a".repeat(81)]) {
    expect(() => normalizeAlias(value)).toThrow();
    expect(() => store.save({}, {}, { one: value })).toThrow();
  }
  expect(normalizeAlias(" ")).toBeUndefined();
  expect(normalizeAlias("測".repeat(80))).toHaveLength(80);
  for (const aliases of [[], { one: 3 }, { one: "\u001b[31m" }, { one: "" }]) {
    const data = JSON.stringify({ version: 1, order: {}, aliases });
    writeFileSync(path, data);
    expect(() => store.save({ test: ["a"] }, {})).toThrow();
    expect(readFileSync(path, "utf8")).toBe(data);
  }
});
test("native credentials, not rankings, define account membership", () => {
  const provider = (id: string) =>
    ({ id, getModels: () => [{}], auth: { apiKey: {}, oauth: {} } }) as unknown as Provider;
  const accounts = nativeAccounts(
    [provider("codex"), provider("other")],
    [
      { providerId: "codex", type: "oauth" },
      { providerId: loginId("codex", 2), type: "oauth" },
      { providerId: "other", type: "api_key" },
      { providerId: loginId("missing", 2), type: "api_key" },
    ],
  );
  expect(accounts.map((a) => a.name)).toEqual(["Account 1", "Account 2", "Account 1"]);
  const ranked = rankAccounts(accounts, {
    codex: [loginId("codex", 2), "deleted", "native:codex"],
  });
  expect(multipleAccounts(ranked).map((a) => a.name)).toEqual(["Account 2", "Account 1"]);
  const labeled = rankAccounts(accounts, {}, { "native:other": "Work", ghost: "Not a login" });
  expect(labeled).toHaveLength(accounts.length);
  expect(labeled.find((a) => a.id === "native:other")?.alias).toBe("Work");
  expect(accounts.every((a) => a.alias === undefined)).toBe(true);
  expect(multipleAccounts(accounts.filter((a) => a.id !== loginId("codex", 2)))).toEqual([]);
  expect(parseLoginId(loginId("openai-codex", 12))).toEqual({
    provider: "openai-codex",
    number: 12,
  });
  for (const id of [
    "account--test--1",
    "account--test--02",
    "account--test--9007199254740992",
    "account--../../bad--2",
  ])
    expect(parseLoginId(id)).toBeUndefined();
});
test("legacy account metadata is read-only and cannot invent signed-in credentials", () => {
  const { path } = setup();
  const data = JSON.stringify({
    version: 1,
    accounts: [
      { id: "a", name: "personal", provider: "test", credentialId: "account-a", enabled: true },
    ],
  });
  writeFileSync(path, data);
  const old = readLegacyAccounts(path);
  expect(old).toHaveLength(1);
  expect(nativeAccounts([], [], old)).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(data);
});
