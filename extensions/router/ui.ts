import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { NativeAccount } from "../../src/account-identity.ts";
import { normalizeAlias } from "./store.ts";

export const MASKED_EMAIL = "••••••••";

interface ProviderDefaults {
  accounts: readonly SessionDefault[];
  change: (accounts: NativeAccount[], selectedId: string) => void;
}

/** Headers show each provider's default; movement and ranking operate only on accounts. */
export class RankingList implements Component {
  private accounts: NativeAccount[];
  private selected = 0;
  private names: Map<string, string>;
  private theme: Theme;
  private keys: KeybindingsManager;
  private done: (accounts?: NativeAccount[]) => void;
  private height: () => number;
  private rename?: (accounts: NativeAccount[], id: string) => void;
  private emails: ReadonlyMap<string, string>;
  private revealedId?: string;
  private defaults?: ProviderDefaults;
  private search = new Input({ prompt: "> ", placeholder: "Search accounts…" });
  get focused(): boolean {
    return this.search.focused;
  }
  set focused(value: boolean) {
    this.search.focused = value;
  }
  get query(): string {
    return this.search.getValue();
  }
  private visibleAccounts(): NativeAccount[] {
    const query = this.query.trim().toLowerCase();
    return this.accounts.filter((a) =>
      [a.alias, a.name, a.provider, this.names.get(a.provider)].some((value) =>
        value?.toLowerCase().includes(query),
      ),
    );
  }
  constructor(
    accounts: NativeAccount[],
    names: Map<string, string>,
    theme: Theme,
    keys: KeybindingsManager,
    done: (accounts?: NativeAccount[]) => void,
    height: () => number,
    rename?: (accounts: NativeAccount[], id: string) => void,
    selectedId?: string,
    emails: ReadonlyMap<string, string> = new Map(),
    defaults?: ProviderDefaults,
    query = "",
  ) {
    this.search.setValue(query);
    this.defaults = defaults;
    this.names = names;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.height = height;
    this.rename = rename;
    this.emails = emails;
    this.accounts = [...accounts];
    this.selected = Math.max(
      0,
      this.visibleAccounts().findIndex((a) => a.id === selectedId),
    );
  }
  invalidate(): void {
    this.search.invalidate();
  }
  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      this.done(this.accounts);
      return;
    }
    const visible = this.visibleAccounts();
    const selected = visible[this.selected];
    if (matchesKey(data, "space")) {
      this.revealedId = undefined;
      if (selected) this.defaults?.change(this.accounts, selected.id);
      return;
    }
    const move = matchesKey(data, "ctrl+up") ? -1 : matchesKey(data, "ctrl+down") ? 1 : 0;
    if (move) {
      this.revealedId = undefined;
      const index = this.accounts.findIndex((a) => a.id === selected?.id);
      const other = index + move;
      if (selected && this.accounts[other]?.provider === selected.provider) {
        [this.accounts[other], this.accounts[index]] = [selected, this.accounts[other]!];
        this.selected = this.visibleAccounts().findIndex((a) => a.id === selected.id);
      }
    } else if (matchesKey(data, "up")) {
      this.revealedId = undefined;
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.revealedId = undefined;
      this.selected = Math.min(Math.max(0, visible.length - 1), this.selected + 1);
    } else if (matchesKey(data, "ctrl+n") && selected) {
      this.revealedId = undefined;
      this.rename?.(this.accounts, selected.id);
    } else if (matchesKey(data, "ctrl+e") && selected) {
      this.revealedId = this.revealedId === selected.id ? undefined : selected.id;
    } else {
      const before = this.query;
      this.search.handleInput(data);
      if (this.query !== before) {
        this.revealedId = undefined;
        this.selected = 0;
      }
    }
  }
  render(width: number): string[] {
    const t = this.theme;
    const counters = new Map<string, number>();
    const ranks = new Map(
      this.accounts.map((a) => {
        const rank = (counters.get(a.provider) ?? 0) + 1;
        counters.set(a.provider, rank);
        return [a.id, rank] as const;
      }),
    );
    const visible = this.visibleAccounts();
    const room = Math.max(2, Math.min(14, this.height() - 5));
    // Restart the first visible group with its header, even when scrolled into that group.
    const window = (start: number) => {
      const lines: string[] = [];
      let provider: string | undefined;
      let end = start;
      for (let i = start; i < visible.length; i++) {
        const a = visible[i]!;
        const header = provider !== a.provider;
        if (lines.length + (header ? 2 : 1) > room) break;
        if (header) {
          const preferred = this.defaults?.accounts.find((d) => d.provider === a.provider);
          const account = this.accounts.find((item) => item.id === preferred?.accountId);
          const name = this.names.get(a.provider) ?? a.provider;
          lines.push(
            ` ${t.fg("accent", t.bold(account ? `${name}: ${account.alias ?? account.name}` : name))}`,
          );
        }
        provider = a.provider;
        const email = this.emails.get(a.id);
        const isDefault = this.defaults?.accounts.some(
          (d) => d.provider === a.provider && d.accountId === a.id,
        );
        const label = `${i === this.selected ? " >" : "  "} ${ranks.get(a.id)}. ${a.alias ?? ""}${isDefault ? " ✓" : ""}`;
        const address = this.revealedId === a.id ? email : undefined;
        lines.push(
          t.fg(i === this.selected ? "accent" : "text", label.trimEnd()) +
            (address ? t.fg("muted", `  ${address}`) : ""),
        );
        end = i + 1;
      }
      return { lines, end };
    };
    let start = Math.max(0, this.selected - Math.floor(room / 2));
    let view = window(start);
    while (view.end <= this.selected && start < this.selected) view = window(++start);
    const border = new DynamicBorder((s: string) => t.fg("borderAccent", s)).render(width);
    const key = (id: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      this.keys.getKeys(id)[0] ?? "";
    return [
      ...border,
      ...this.search.render(width),
      ...(visible.length ? view.lines : [t.fg("dim", " No matching accounts")]),
      ...(start || view.end < visible.length
        ? [t.fg("dim", ` ${this.selected + 1}/${visible.length} accounts · ↑↓ navigate`)]
        : []),
      t.fg(
        "dim",
        ` ${this.defaults ? "space default · " : ""}ctrl+↑↓ rank · ctrl+n alias · ctrl+e email · ${key("tui.select.confirm")} save · ${key("tui.select.cancel")} cancel`,
      ),
      ...border,
    ].map((s) => truncateToWidth(s, Math.max(0, width)));
  }
}

/** Native input; cancellation returns the original account, blank input clears only the alias. */
export async function promptAlias(
  ctx: ExtensionContext,
  account: NativeAccount,
  providerName: string,
): Promise<NativeAccount> {
  for (;;) {
    const value = await ctx.ui.input(
      `Alias for ${providerName} · ${account.alias ?? account.name} (blank clears)`,
      account.alias ?? "e.g. Personal or Work",
    );
    if (value === undefined) return account;
    try {
      return { ...account, alias: normalizeAlias(value) };
    } catch {
      ctx.ui.notify(
        "Use a single-line alias of at most 80 characters, without control characters.",
        "warning",
      );
    }
  }
}

type RankingAction = NativeAccount[] | { accounts: NativeAccount[]; renameId: string } | undefined;
export interface SessionDefault {
  provider: string;
  accountId: string;
}
export interface RankingResult {
  accounts: NativeAccount[];
  sessionDefaults: SessionDefault[];
}
export async function showRankings(
  ctx: ExtensionContext,
  accounts: NativeAccount[],
  names: Map<string, string>,
  emails: ReadonlyMap<string, string> = new Map(),
  sessionDefaults: readonly SessionDefault[] = [],
): Promise<RankingResult | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      accounts
        .map(
          (a) =>
            `${names.get(a.provider) ?? a.provider} · ${a.alias ?? ""}  ${emails.has(a.id) ? MASKED_EMAIL : ""}`,
        )
        .join("\n") +
        "\nUse TUI mode for the default account and ranked fallbacks, /router account to select a session default, /router alias to label accounts. Manage logins with /login and /logout.",
      "info",
    );
    return;
  }
  let pending = accounts;
  const pendingDefaults = sessionDefaults.map((d) => ({ ...d }));
  let selectedId: string | undefined;
  let query = "";
  for (;;) {
    const result = await ctx.ui.custom<RankingAction>((tui, theme, keys, done) => {
      const view = new RankingList(
        pending,
        names,
        theme,
        keys,
        done,
        () => tui.terminal.rows,
        (accounts, renameId) => {
          query = view.query;
          done({ accounts, renameId });
        },
        selectedId,
        emails,
        pendingDefaults.length
          ? {
              accounts: pendingDefaults,
              change: (accounts, selectedId) => {
                const account = accounts.find((a) => a.id === selectedId)!;
                const preferred = pendingDefaults.find((d) => d.provider === account.provider);
                if (preferred) preferred.accountId = selectedId;
              },
            }
          : undefined,
        query,
      );
      const handleInput = view.handleInput.bind(view);
      view.handleInput = (data) => {
        handleInput(data);
        tui.requestRender();
      };
      return view;
    });
    if (!result) return;
    if (Array.isArray(result)) return { accounts: result, sessionDefaults: pendingDefaults };
    pending = result.accounts;
    if (!("renameId" in result)) continue;
    selectedId = result.renameId;
    const account = pending.find((a) => a.id === selectedId)!;
    const updated = await promptAlias(
      ctx,
      account,
      names.get(account.provider) ?? account.provider,
    );
    pending = pending.map((a) => (a.id === updated.id ? updated : a));
  }
}
