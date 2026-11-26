import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** A tool call, or anything the transcript shows between calls: text, a prompt, a notice. */
export type Item = { kind: "tool"; id: string; name: string } | { kind: "break" };

/** The settings that decide what Pi draws between tool rows. */
export interface DisplayOptions {
  /** Thinking blocks are shown, not hidden. */
  showThinking: boolean;
  /** Pi prints cache-miss notices after the responses that paid for them. */
  cacheMissNotices: boolean;
  /** Pi prints cache-warming notices. */
  cacheWarmingNotices: boolean;
  /** Pi prints a notice when a provider drops earlier reasoning (live responses only). */
  reasoningDropNotices?: boolean;
  /** A model's cache-read price per million tokens, for the cache-miss threshold. */
  cacheReadCost?: (provider: string, model: string) => number | undefined;
}

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { input?: number; cacheRead?: number; cacheWrite?: number };
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  timestamp?: unknown;
  display?: unknown;
  usage?: Usage;
  provider?: unknown;
  model?: unknown;
  diagnostics?: unknown;
}

const BREAK: Item = { kind: "break" };

/**
 * What one message contributes to the timeline, in the order Pi draws it: an assistant
 * message's text, thinking and truncation notice come first, then all of its tool calls.
 */
export function itemsOfMessage(
  message: MessageLike,
  options: Pick<DisplayOptions, "showThinking">,
  cacheMissNotice = false,
): Item[] {
  if (message.role === "toolResult") return [];
  if (message.role === "custom") return message.display === false ? [] : [BREAK];
  if (message.role !== "assistant") return [BREAK];
  const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  let shown = message.stopReason === "length";
  const calls: Item[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const part = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      id?: unknown;
      name?: unknown;
    };
    if (part.type === "toolCall" && typeof part.id === "string")
      calls.push({
        kind: "tool",
        id: part.id,
        name: typeof part.name === "string" ? part.name : "",
      });
    else if (part.type === "text" && typeof part.text === "string" && part.text.trim())
      shown = true;
    else if (
      part.type === "thinking" &&
      options.showThinking &&
      typeof part.thinking === "string" &&
      part.thinking.trim()
    )
      shown = true;
  }
  const items: Item[] = shown ? [BREAK, ...calls] : calls;
  // Without tool rows to carry it, a failed or aborted response prints its error.
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  if (failed && calls.length === 0) items.push(BREAK);
  if (cacheMissNotice && !failed) items.push(BREAK);
  return items;
}

/** Pi's cache-miss notice thresholds: smaller misses print nothing. */
const MISS_TOKENS = 20_000;
const MISS_COST = 0.1;
const NOISE_FLOOR_TOKENS = 1024;

/**
 * The responses Pi follows with a cache-miss notice, by reference. Mirrors Pi's own scan over
 * every session entry (`cache-stats.ts`) and its display threshold.
 */
export function cacheMissMessages(
  entries: readonly SessionEntry[],
  cacheReadCost?: DisplayOptions["cacheReadCost"],
): Set<unknown> {
  const misses = new Set<unknown>();
  let prev: { promptTokens: number; reportedCache: boolean } | undefined;
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    const usageEntry = entry as { type: string; kind?: unknown; usage?: Usage };
    if (usageEntry.type === "usage" && usageEntry.kind === "cache_warm" && usageEntry.usage) {
      const tokens =
        usageEntry.usage.input + usageEntry.usage.cacheRead + usageEntry.usage.cacheWrite;
      if (tokens > 0) prev = { promptTokens: tokens, reportedCache: true };
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as MessageLike;
    const usage = message.usage;
    if (message.role !== "assistant" || !usage) continue;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const cached = usage.cacheRead + usage.cacheWrite > 0;
    if (prev && promptTokens > 0 && (cached || prev.reportedCache)) {
      const missed = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
      if (missed > NOISE_FLOOR_TOKENS) {
        const paid = usage.input + usage.cacheWrite;
        const paidRate =
          paid > 0 ? ((usage.cost?.input ?? 0) + (usage.cost?.cacheWrite ?? 0)) / paid : 0;
        const readRate =
          usage.cacheRead > 0
            ? (usage.cost?.cacheRead ?? 0) / usage.cacheRead
            : (cacheReadCost?.(String(message.provider), String(message.model)) ?? 0) / 1_000_000;
        const cost = missed * Math.max(0, paidRate - readRate);
        if (missed >= MISS_TOKENS || cost >= MISS_COST) misses.add(message);
      }
    }
    if (promptTokens > 0)
      prev = { promptTokens, reportedCache: (prev?.reportedCache ?? false) || cached };
  }
  return misses;
}

/** Provider diagnostics that report dropped reasoning, and the transformation that counts. */
const REASONING_DROPS: Record<string, string> = {
  anthropic_input_transformations: "thinking_dropped",
  openai_input_transformations: "reasoning",
};

/** How much earlier reasoning a provider says it dropped for this response. */
export function droppedReasoning(
  message: MessageLike,
): { kind: string; count: number } | undefined {
  const diagnostics = Array.isArray(message.diagnostics) ? (message.diagnostics as unknown[]) : [];
  for (const diagnostic of diagnostics) {
    const entry = diagnostic as { type?: unknown; details?: { transformations?: unknown } };
    const dropped = typeof entry.type === "string" ? REASONING_DROPS[entry.type] : undefined;
    const transformations = entry.details?.transformations;
    if (!dropped || !Array.isArray(transformations)) continue;
    const count = transformations.filter(
      (t) => typeof t === "object" && t !== null && (t as { type?: unknown }).type === dropped,
    ).length;
    if (count > 0) return { kind: entry.type as string, count };
  }
  return undefined;
}

/**
 * Pi prints a reasoning-drop notice under a finished response that drops more than the response
 * before it. `branch` is the session before this response is saved, as at `message_end`.
 */
export function showsReasoningDrop(message: MessageLike, branch: readonly SessionEntry[]): boolean {
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  const dropped = droppedReasoning(message);
  if (!dropped) return false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]!;
    if (entry.type !== "message" || (entry.message as MessageLike).role !== "assistant") continue;
    const previous = droppedReasoning(entry.message as MessageLike);
    return !(previous?.kind === dropped.kind && dropped.count <= previous.count);
  }
  return true;
}

/** A compaction Pi drew where it happened, after the entries it kept, instead of first. */
export interface LiveCompaction {
  id: string;
  /** Entries after the compaction in the branch: Pi draws these after its summary. */
  after: ReadonlySet<string>;
}

/**
 * The timeline of the entries Pi draws (`buildContextEntries()`: compaction-aware), and the
 * timestamps of the responses among them. `allEntries` feeds the cache-miss scan; `live` adds
 * what Pi drew live and does not redraw: notices under responses, and a compaction's position.
 */
export function timelineOf(
  entries: readonly SessionEntry[],
  allEntries: readonly SessionEntry[],
  options: DisplayOptions,
  live: { noticesAfter?: ReadonlySet<unknown>; compaction?: LiveCompaction } = {},
): { items: Item[]; responses: Set<unknown> } {
  const items: Item[] = [];
  const responses = new Set<unknown>();
  const misses = options.cacheMissNotices
    ? cacheMissMessages(allEntries, options.cacheReadCost)
    : new Set();
  let summaryDrawn = false;
  for (const entry of entries) {
    // A compaction drawn live sits between the entries it kept and the ones that followed.
    if (live.compaction && !summaryDrawn && live.compaction.after.has(entry.id)) {
      items.push(BREAK);
      summaryDrawn = true;
    }
    if (entry.type === "message") {
      const message = entry.message as MessageLike;
      if (message.role === "assistant") responses.add(message.timestamp);
      const notice = misses.has(message) || (live.noticesAfter?.has(message.timestamp) ?? false);
      items.push(...itemsOfMessage(message, options, notice));
    } else if (entry.type === "custom_message") {
      if (entry.display) items.push(BREAK);
    } else if (entry.type === "custom") {
      // Drawn when its extension registered an entry renderer, which Tidy cannot see: splitting
      // a run at an invisible entry is harmless, drawing reads above a visible card is not.
      items.push(BREAK);
    } else if (entry.type === "compaction" && entry.id === live.compaction?.id) {
      // Drawn after the entries it kept: see above.
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      items.push(BREAK);
    } else if ((entry as { type: string; kind?: unknown }).type === "usage") {
      if ((entry as { kind?: unknown }).kind === "cache_warm" && options.cacheWarmingNotices)
        items.push(BREAK);
    }
  }
  if (live.compaction && !summaryDrawn) items.push(BREAK);
  return { items, responses };
}

/**
 * For each call whose tool `isExplore` accepts, the run of such calls it belongs to: calls next
 * to each other with nothing drawn between them.
 */
export function segmentsOf(
  items: readonly Item[],
  isExplore: (name: string, id: string) => boolean,
): Map<string, string[]> {
  const segments = new Map<string, string[]>();
  let segment: string[] = [];
  for (const item of items) {
    if (item.kind === "tool" && isExplore(item.name, item.id)) {
      segment.push(item.id);
      segments.set(item.id, segment);
    } else if (segment.length > 0) {
      segment = [];
    }
  }
  return segments;
}

/** Items equal for grouping: the same breaks and calls, each with the same name. */
const sameItems = (a: readonly Item[], b: readonly Item[]) =>
  a.length === b.length &&
  a.every((item, i) => {
    const other = b[i]!;
    if (item.kind === "break" || other.kind === "break") return item.kind === other.kind;
    return item.id === other.id && item.name === other.name;
  });

const optionsKey = (options: DisplayOptions) =>
  [
    options.showThinking,
    options.cacheMissNotices,
    options.cacheWarmingNotices,
    options.reasoningDropNotices,
  ].join("/");

/** Where the timeline reads the session. */
export interface TimelineSource {
  /** What Pi draws: `buildContextEntries()`. */
  context(): readonly SessionEntry[];
  /** Every entry, for the cache-miss scan: `getEntries()`. */
  all(): readonly SessionEntry[];
  /** The current branch: `getBranch()`. */
  branch(): readonly SessionEntry[];
  /** The current leaf: `getLeafId()`. Any new entry or move in the tree changes it. */
  leafId(): string | null;
}

/**
 * Tracks which exploration calls sit next to each other in the transcript. Rows ask at render
 * time; the session is scanned again only after it changes, and a streaming response only matters
 * when it gains a call or visible text.
 */
export class Timeline {
  private source: TimelineSource | undefined;
  private readOptions: () => DisplayOptions;
  private isExplore: (name: string, id: string) => boolean;
  private options: DisplayOptions | undefined;
  private optionsFresh = false;
  private live: MessageLike | undefined;
  private liveItems: Item[] = [];
  private branchVersion = 0;
  private liveVersion = 0;
  private leaf: string | null | undefined;
  /** Responses Pi followed with a live-only notice, by timestamp. */
  private noticesAfter = new Set<unknown>();
  /** The compaction Pi drew first when it last drew the whole transcript. */
  private knownCompaction: string | undefined;
  /** A compaction Pi drew where it happened, until it next draws the whole transcript. */
  private liveCompaction: string | undefined;
  private redrawNoted = false;
  /** The first compaction when the session was last scanned. */
  private scannedCompaction: string | undefined;
  /**
   * Called with every call Pi draws after a scan finds a new compaction: rows for other calls
   * are gone, even if Pi kept no row to redraw.
   */
  onCompacted: (ids: ReadonlySet<string>) => void = () => {};
  private scanned: { version: number; items: Item[]; responses: Set<unknown> } | undefined;
  private cache:
    | { branch: number; live: number; segments: Map<string, string[]>; retried: boolean }
    | undefined;

  constructor(readOptions: () => DisplayOptions, isExplore: (name: string, id: string) => boolean) {
    this.readOptions = readOptions;
    this.isExplore = isExplore;
  }

  /** A new session or a reload: Pi draws it from the start. */
  reset(source: TimelineSource | undefined): void {
    this.source = source;
    this.noticesAfter.clear();
    this.liveCompaction = undefined;
    this.knownCompaction = this.firstCompaction();
    this.scannedCompaction = this.knownCompaction;
    this.clearLive();
    this.changed();
  }

  /**
   * Pi drew the transcript again (a row was replaced). A compaction first seen now was drawn where
   * it happened; otherwise Pi drew everything from the start, summary first, without live notices.
   */
  noteRedraw(): void {
    // Pi rebuilds the whole transcript synchronously, replacing every row: note it once.
    if (this.redrawNoted) return;
    this.redrawNoted = true;
    queueMicrotask(() => (this.redrawNoted = false));
    const first = this.firstCompaction();
    this.liveCompaction = first !== undefined && first !== this.knownCompaction ? first : undefined;
    this.knownCompaction = first;
    this.noticesAfter.clear();
    this.changed();
  }

  /** A response finished: note the live-only notices Pi prints under it. Call before it is saved. */
  noteResponseEnd(message: MessageLike): void {
    if (!this.currentOptions(true).reasoningDropNotices) return;
    let branch: readonly SessionEntry[] = [];
    try {
      branch = this.source?.branch() ?? [];
    } catch {
      return;
    }
    if (showsReasoningDrop(message, branch)) {
      this.noticesAfter.add(message.timestamp);
      this.changed();
    }
  }

  /** The response that is streaming now, which the session gets once it ends. */
  setLive(message: MessageLike | undefined): void {
    const items = message ? itemsOfMessage(message, this.currentOptions()) : [];
    const same =
      message?.timestamp === this.live?.timestamp &&
      (message === undefined) === (this.live === undefined) &&
      sameItems(items, this.liveItems);
    // Pi sends each update as a new object: the runs change only with the calls or the response.
    this.live = message;
    if (same) return;
    this.liveItems = items;
    this.liveVersion++;
  }

  /** Forget the streaming response, as after moving in the session tree. */
  clearLive(): void {
    this.setLive(undefined);
  }

  /** The session changed: a message was saved, the tree moved, or the session compacted. */
  changed(): void {
    this.branchVersion++;
  }

  /** The run of reads and searches `id` belongs to, or undefined for other calls. */
  segment(id: string): string[] | undefined {
    this.currentOptions();
    // Entries can arrive without an event extensions see, such as another extension's compaction.
    let leaf: string | null | undefined;
    try {
      leaf = this.source?.leafId();
    } catch {
      leaf = undefined;
    }
    if (leaf !== this.leaf) {
      this.leaf = leaf;
      this.changed();
    }
    const fresh = this.cache?.branch === this.branchVersion && this.cache.live === this.liveVersion;
    if (!fresh) this.recompute(false);
    let segment = this.cache!.segments.get(id);
    // A row can draw before the event that records its call; scan once more per change.
    if (!segment && !this.cache!.retried) {
      this.branchVersion++;
      this.recompute(true);
      segment = this.cache!.segments.get(id);
    }
    return segment;
  }

  private firstCompaction(): string | undefined {
    try {
      const first = this.source?.context()[0];
      return first?.type === "compaction" ? first.id : undefined;
    } catch {
      return undefined;
    }
  }

  /** The display settings, read once per render pass; a change rescans the session. */
  private currentOptions(force = false): DisplayOptions {
    if (force || !this.options || !this.optionsFresh) {
      // Rows of one frame draw in one synchronous pass: read once per pass.
      this.optionsFresh = true;
      queueMicrotask(() => (this.optionsFresh = false));
      const next = this.readOptions();
      const changed = this.options !== undefined && optionsKey(next) !== optionsKey(this.options);
      this.options = next;
      if (changed) {
        this.changed();
        // The streaming response's items depend on the settings too.
        this.liveItems = this.live ? itemsOfMessage(this.live, next) : [];
        this.liveVersion++;
      }
    }
    return this.options;
  }

  private recompute(retried: boolean): void {
    if (this.scanned?.version !== this.branchVersion) {
      let context: readonly SessionEntry[] = [];
      let all: readonly SessionEntry[] = [];
      let compaction: LiveCompaction | undefined;
      try {
        context = this.source?.context() ?? [];
        all = this.source?.all() ?? [];
        if (this.liveCompaction) {
          const branch = this.source?.branch() ?? [];
          const at = branch.findIndex((entry) => entry.id === this.liveCompaction);
          compaction = {
            id: this.liveCompaction,
            after: new Set(at < 0 ? [] : branch.slice(at + 1).map((entry) => entry.id)),
          };
        }
      } catch {
        // A stale session manager after a reload; the next session_start replaces it.
      }
      this.scanned = {
        version: this.branchVersion,
        ...timelineOf(context, all, this.currentOptions(), {
          noticesAfter: this.noticesAfter,
          ...(compaction ? { compaction } : {}),
        }),
      };
    }
    const { items, responses } = this.scanned;
    const compaction = this.firstCompaction();
    if (compaction !== undefined && compaction !== this.scannedCompaction) {
      const ids = new Set<string>();
      for (const item of [...items, ...this.liveItems]) if (item.kind === "tool") ids.add(item.id);
      this.onCompacted(ids);
    }
    this.scannedCompaction = compaction;
    const live = this.live && !responses.has(this.live.timestamp) ? this.liveItems : [];
    this.cache = {
      branch: this.branchVersion,
      live: this.liveVersion,
      segments: segmentsOf(live.length > 0 ? [...items, ...live] : items, this.isExplore),
      retried,
    };
  }
}
