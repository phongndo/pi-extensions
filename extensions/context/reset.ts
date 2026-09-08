type Request = { checkpointId: string; compacted: boolean };
type State =
  | { status: "idle" | "closed" }
  | { status: "requested"; request: Request }
  | { status: "compacting" };

/** Owns reset lifetimes. Callbacks from aborted/replaced requests cannot consume newer work. */
export class ResetController {
  private state: State = { status: "idle" };

  get closed(): boolean {
    return this.state.status === "closed";
  }

  cancel(close = false): void {
    this.state = { status: close || this.closed ? "closed" : "idle" };
  }

  request(checkpointId: string, signal?: AbortSignal): void {
    if (this.closed || signal?.aborted) return;
    const pending: State = { status: "requested", request: { checkpointId, compacted: false } };
    this.state = pending;
    signal?.addEventListener(
      "abort",
      () => {
        if (this.state === pending) this.cancel();
      },
      { once: true },
    );
  }

  /** Stock fallback compaction also permits continuation. */
  compacted(): string | undefined {
    if (this.state.status !== "requested") return undefined;
    this.state.request.compacted = true;
    return this.state.request.checkpointId;
  }

  take(): Request | undefined {
    if (this.state.status !== "requested") return undefined;
    const request = this.state.request;
    this.cancel();
    return request;
  }

  /** Returns a single-use completion guard, invalidated by cancellation or replacement. */
  begin(): () => boolean {
    if (this.closed) return () => false;
    const compacting: State = { status: "compacting" };
    this.state = compacting;
    return () => {
      if (this.state !== compacting) return false;
      this.cancel();
      return true;
    };
  }
}
