import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { NativeAccount } from "../../src/account-identity.ts";
import { normalizeAlias } from "./store.ts";

export const MASKED_EMAIL = "••••••••";

/** Headers are not selectable; movement and ranking operate only on accounts. */
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
  ) {
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
      accounts.findIndex((a) => a.id === selectedId),
    );
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.done();
      return;
    }
    if (this.keys.matches(data, "tui.select.confirm")) {
      this.done(this.accounts);
      return;
    }
    const move = this.keys.matches(data, "app.models.reorderUp")
      ? -1
      : this.keys.matches(data, "app.models.reorderDown")
        ? 1
        : 0;
    if (move) {
      this.revealedId = undefined;
      const other = this.selected + move;
      if (
        this.accounts[other] &&
        this.accounts[other]!.provider === this.accounts[this.selected]?.provider
      ) {
        [this.accounts[other], this.accounts[this.selected]] = [
          this.accounts[this.selected]!,
          this.accounts[other]!,
        ];
        this.selected = other;
      }
    } else if (this.keys.matches(data, "tui.select.up")) {
      this.revealedId = undefined;
      this.selected = Math.max(0, this.selected - 1);
    } else if (this.keys.matches(data, "tui.select.down")) {
      this.revealedId = undefined;
      this.selected = Math.min(Math.max(0, this.accounts.length - 1), this.selected + 1);
    } else if (matchesKey(data, "n") && this.accounts[this.selected]) {
      this.revealedId = undefined;
      this.rename?.(this.accounts, this.accounts[this.selected]!.id);
    } else if (matchesKey(data, "e") && this.accounts[this.selected]) {
      const id = this.accounts[this.selected]!.id;
      this.revealedId = this.revealedId === id ? undefined : id;
    }
  }
  render(width: number): string[] {
    const t = this.theme;
    const counters = new Map<string, number>();
    const ranks = this.accounts.map((a) => {
      const rank = (counters.get(a.provider) ?? 0) + 1;
      counters.set(a.provider, rank);
      return rank;
    });
    const room = Math.max(2, Math.min(14, this.height() - 7));
    // Restart the first visible group with its header, even when scrolled into that group.
    const window = (start: number) => {
      const lines: string[] = [];
      let provider: string | undefined;
      let end = start;
      for (let i = start; i < this.accounts.length; i++) {
        const a = this.accounts[i]!;
        const header = provider !== a.provider;
        if (lines.length + (header ? 2 : 1) > room) break;
        if (header)
          lines.push(` ${t.fg("accent", t.bold(this.names.get(a.provider) ?? a.provider))}`);
        provider = a.provider;
        const email = this.emails.get(a.id);
        const label = `${i === this.selected ? " >" : "  "} ${ranks[i]}. ${a.alias ?? ""}`;
        const address = email ? (this.revealedId === a.id ? email : MASKED_EMAIL) : "";
        lines.push(
          t.fg(i === this.selected ? "accent" : "text", label) + t.fg("muted", `  ${address}`),
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
      this.keys.getKeys(id).join("/");
    return [
      ...border,
      ` ${t.fg("accent", t.bold("Router"))} ${t.fg("muted", "· priority within each provider")}`,
      ...view.lines,
      ...(start || view.end < this.accounts.length
        ? [
            t.fg(
              "dim",
              ` ${this.selected + 1}/${this.accounts.length} accounts · ${key("tui.select.up")}/${key("tui.select.down")} navigate`,
            ),
          ]
        : []),
      t.fg(
        "dim",
        ` ${key("app.models.reorderUp")}/${key("app.models.reorderDown")} rank · n alias · e email · ${key("tui.select.confirm")} save · ${key("tui.select.cancel")} cancel`,
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
export async function showRankings(
  ctx: ExtensionContext,
  accounts: NativeAccount[],
  names: Map<string, string>,
  emails: ReadonlyMap<string, string> = new Map(),
): Promise<NativeAccount[] | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(
      accounts
        .map(
          (a) =>
            `${names.get(a.provider) ?? a.provider} · ${a.alias ?? ""}  ${emails.has(a.id) ? MASKED_EMAIL : ""}`,
        )
        .join("\n") +
        "\nUse TUI mode to reorder, /router alias to label accounts. Manage logins with /login and /logout.",
      "info",
    );
    return;
  }
  let pending = accounts;
  let selectedId: string | undefined;
  for (;;) {
    const result = await ctx.ui.custom<RankingAction>((tui, theme, keys, done) => {
      const view = new RankingList(
        pending,
        names,
        theme,
        keys,
        done,
        () => tui.terminal.rows,
        (accounts, renameId) => done({ accounts, renameId }),
        selectedId,
        emails,
      );
      return {
        render: (width) => view.render(width),
        invalidate: () => view.invalidate(),
        handleInput: (data) => {
          view.handleInput(data);
          tui.requestRender();
        },
      };
    });
    if (!result || Array.isArray(result)) return result;
    pending = result.accounts;
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
