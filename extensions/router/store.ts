import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LegacyAccount, NativeAccount } from "../../src/account-identity.ts";
export { poolId, sourceProvider } from "../../src/account-identity.ts";
export type Account = NativeAccount;
export type Rankings = Record<string, string[]>;
export type Aliases = Record<string, string>;
interface Metadata {
  version: 1;
  order: Rankings;
  aliases: Aliases;
}
export function normalizeAlias(value: string): string | undefined {
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(value) || [...value.trim()].length > 80)
    throw new Error(
      "Use a single-line alias of at most 80 characters, without control characters.",
    );
  return value.trim() || undefined;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read ${path}; it has not been overwritten.`);
  }
}
function rankings(value: unknown): Rankings {
  if (value === undefined) return {};
  const data = value as { version?: number; order?: Rankings };
  if (
    data?.version !== 1 ||
    !data.order ||
    typeof data.order !== "object" ||
    Array.isArray(data.order) ||
    Object.values(data.order).some(
      (ids) =>
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== "string") ||
        new Set(ids).size !== ids.length,
    )
  )
    throw new Error("Invalid router.json rankings.");
  return Object.assign(Object.create(null), data.order);
}
function metadata(value: unknown): Metadata {
  const order = rankings(value);
  const aliases = (value as { aliases?: unknown } | undefined)?.aliases ?? {};
  if (
    typeof aliases !== "object" ||
    Array.isArray(aliases) ||
    Object.values(aliases).some(
      (alias) => typeof alias !== "string" || !alias || normalizeAlias(alias) !== alias,
    )
  )
    throw new Error("Invalid router.json aliases.");
  return { version: 1, order, aliases: Object.assign(Object.create(null), aliases) };
}
/** Read-only compatibility for accounts created by the earlier /router add UI. Never touches auth. */
export function readLegacyAccounts(path = join(getAgentDir(), "accounts.json")): LegacyAccount[] {
  const data = readJson(path) as { version?: number; accounts?: LegacyAccount[] } | undefined;
  if (!data) return [];
  if (data.version !== 1 || !Array.isArray(data.accounts))
    throw new Error("Invalid legacy accounts.json.");
  return data.accounts
    .filter(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        /^[a-zA-Z0-9_-]{1,40}$/.test(a.name) &&
        typeof a.provider === "string" &&
        (a.credentialId === a.provider || a.credentialId === `account-${a.id}`),
    )
    .map(({ id, name, provider, credentialId }) => ({ id, name, provider, credentialId }));
}
export function rankAccounts(
  accounts: NativeAccount[],
  order: Rankings,
  aliases: Aliases = {},
): NativeAccount[] {
  return accounts
    .map((a) => ({ ...a, alias: Object.hasOwn(aliases, a.id) ? aliases[a.id] : undefined }))
    .sort((a, b) => {
      if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
      const ids = order[a.provider] ?? [];
      const index = (id: string) => {
        const i = ids.indexOf(id);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      return index(a.id) - index(b.id);
    });
}
export function multipleAccounts(accounts: NativeAccount[]): NativeAccount[] {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.provider, (counts.get(a.provider) ?? 0) + 1);
  return accounts.filter((a) => counts.get(a.provider)! >= 2);
}

/** Only ranking/label metadata is persisted; login/logout remain entirely Pi-owned. */
export class RankingStore {
  private path: string;
  constructor(path = join(getAgentDir(), "router.json")) {
    this.path = path;
  }
  readMetadata(): Metadata {
    return metadata(readJson(this.path));
  }
  read(): Rankings {
    return this.readMetadata().order;
  }
  readAliases(): Aliases {
    return this.readMetadata().aliases;
  }
  save(
    changes: Rankings,
    expected: Rankings,
    aliasChanges: Record<string, string | undefined> = {},
    expectedAliases: Aliases = {},
  ): void {
    if (!Object.keys(changes).length && !Object.keys(aliasChanges).length) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const release = lockfile.lockSync(this.path, { realpath: false });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const { order, aliases } = this.readMetadata();
      for (const [provider, ids] of Object.entries(changes)) {
        if (JSON.stringify(order[provider] ?? []) !== JSON.stringify(expected[provider] ?? []))
          throw new Error("Ranking changed in another session. Reopen /router.");
        order[provider] = ids;
      }
      for (const [id, alias] of Object.entries(aliasChanges)) {
        const expected = Object.hasOwn(expectedAliases, id) ? expectedAliases[id] : undefined;
        if (aliases[id] !== expected)
          throw new Error("Alias changed in another session. Reopen /router.");
        const label = alias === undefined ? undefined : normalizeAlias(alias);
        if (label === undefined) delete aliases[id];
        else aliases[id] = label;
      }
      const data = metadata({ version: 1, order, aliases });
      writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temp, this.path);
    } finally {
      rmSync(temp, { force: true });
      release();
    }
  }
}
