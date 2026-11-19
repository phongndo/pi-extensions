import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import {
  FAST_MODE_STATE_PATH,
  loadFastSpeed,
  setFastMode,
  setFastSpeed,
  toggleFastSpeed,
  type FastSpeed,
} from "./state.ts";

/** Unknown, known, or failed: an error cannot simultaneously report enabled. */
export type FastStateSnapshot =
  | { enabled?: never; speed?: never; error?: never }
  | { enabled: boolean; speed?: FastSpeed; error?: never }
  | { enabled?: never; speed?: never; error: string };

/** A snapshot's speed; older callers may only supply `enabled`. */
export function snapshotSpeed(state: FastStateSnapshot): FastSpeed | undefined {
  if (state.error || state.enabled === undefined) return undefined;
  return state.speed ?? (state.enabled ? "fast" : "off");
}

/** `true`/`false` set Fast/Off; a speed sets it; `{ toggle }` flips between Off and that speed. */
export type FastStateChange = boolean | FastSpeed | { toggle: Exclude<FastSpeed, "off"> };

/** UI snapshot only. Requests still read authoritative state; old reads cannot overwrite newer UI. */
export class FastStateMonitor {
  snapshot: FastStateSnapshot = {};
  private generation = 0;
  private closed = false;
  private watcher?: FSWatcher;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private readonly changed: () => void;
  private readonly path: string;
  private readonly read: () => Promise<FastSpeed>;

  constructor(
    changed: () => void,
    path = FAST_MODE_STATE_PATH,
    read: () => Promise<FastSpeed> = () => loadFastSpeed(path),
  ) {
    this.changed = changed;
    this.path = path;
    this.read = read;
  }

  async refresh(): Promise<FastSpeed> {
    const generation = ++this.generation;
    try {
      const speed = await this.read();
      this.publish(generation, { enabled: speed !== "off", speed });
      return speed;
    } catch (error) {
      this.publish(generation, { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private publish(generation: number, snapshot: FastStateSnapshot): void {
    if (this.closed || generation !== this.generation) return;
    if (
      snapshot.enabled === this.snapshot.enabled &&
      snapshot.speed === this.snapshot.speed &&
      snapshot.error === this.snapshot.error
    )
      return;
    this.snapshot = snapshot;
    try {
      this.changed();
    } catch {
      /* A disposed UI must not turn a valid state read into a request failure. */
    }
  }

  async change(value: FastStateChange = { toggle: "fast" }): Promise<FastSpeed> {
    this.generation++; // Invalidate reads started before a local write.
    try {
      if (typeof value === "object") await toggleFastSpeed(value.toggle, this.path);
      else if (typeof value === "boolean") await setFastMode(value, this.path);
      else await setFastSpeed(value, this.path);
    } catch (error) {
      this.publish(++this.generation, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    return this.refresh();
  }

  private attachWatcher(): void {
    if (this.watcher || this.closed) return;
    try {
      // Watch the parent because writes atomically replace the state file's inode.
      const watcher = watch(dirname(this.path), { persistent: false }, (_event, filename) => {
        if (filename !== null && filename.toString() !== basename(this.path)) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.debounce = undefined;
          void this.refresh().catch(() => undefined);
        }, 25);
        this.debounce.unref();
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
      this.watcher = watcher;
    } catch {
      /* Missing directory or unsupported watcher: polling remains authoritative. */
    }
  }

  start(pollMs = 1000, tick?: () => void): void {
    if (this.poll || this.closed) return;
    this.attachWatcher();
    this.poll = setInterval(() => {
      this.attachWatcher();
      // Slow storage must not start an unbounded queue or continuously invalidate
      // every preceding read before it can publish a snapshot.
      if (this.polling) return;
      this.polling = true;
      void this.refresh()
        .catch(() => undefined)
        .then(() => {
          this.polling = false;
          if (!this.closed) {
            try {
              tick?.();
            } catch {
              /* Best-effort time-dependent UI refresh. */
            }
          }
        });
    }, pollMs);
    this.poll.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher = undefined;
    this.poll = undefined;
    this.debounce = undefined;
  }
}
