import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { isRecord, type FastCapability } from "./capabilities.ts";

export type ObservedTier = "priority" | "fast" | "default" | "auto" | "flex" | "scale" | "unknown";

export interface FastRequestRecord {
  id: number;
  model: string;
  startedAt: number;
  requestedTier: ObservedTier | "omitted";
  applied: boolean;
  capability: FastCapability;
  configuredTransport: StreamOptions["transport"];
  observedTransport: "sse" | "unknown";
  httpStatus?: number;
  responseTier?: ObservedTier;
  firstOutputMs?: number;
  completedMs?: number;
}

export function observedTier(value: unknown): ObservedTier {
  return typeof value === "string" &&
    ["priority", "fast", "default", "auto", "flex", "scale"].includes(value)
    ? (value as ObservedTier)
    : "unknown";
}

export function safeLabel(value: string): string {
  // Never allow model names or remote metadata to inject terminal controls.
  // oxlint-disable-next-line no-control-regex -- Intentionally remove terminal controls.
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 256);
}

/** Bounded, session-local diagnostics; no prompts, credentials, headers or response text. */
export class FastRequestJournal {
  private sequence = 0;
  private readonly records: FastRequestRecord[] = [];
  private readonly changed: () => void;
  private readonly now: () => number;

  constructor(changed: () => void = () => {}, now: () => number = Date.now) {
    // Diagnostics must not break a provider stream if its UI has already gone away.
    this.changed = () => {
      try {
        changed();
      } catch {
        /* Best-effort UI only. */
      }
    };
    this.now = now;
  }

  get last(): FastRequestRecord | undefined {
    return this.records.at(-1);
  }

  begin(
    model: Model<Api>,
    payload: Record<string, unknown>,
    options: StreamOptions,
    applied: boolean,
    capability: FastCapability,
  ): FastRequestObservation {
    const record: FastRequestRecord = {
      id: ++this.sequence,
      model: safeLabel(model.id),
      startedAt: this.now(),
      requestedTier:
        payload.service_tier === undefined ? "omitted" : observedTier(payload.service_tier),
      applied,
      capability,
      configuredTransport: options.transport ?? "auto",
      observedTransport: "unknown",
    };
    this.records.push(record);
    if (this.records.length > 10) this.records.shift();
    this.changed();
    return new FastRequestObservation(record, this.changed, this.now);
  }
}

const MAX_FRAME_CHARS = 64 * 1024;
const TERMINAL_TYPES = [
  "response.completed",
  "response.done",
  "response.incomplete",
  "response.failed",
  "error",
];
const TERMINAL_EVENT = /response\.(?:completed|done|incomplete|failed)|"type"\s*:\s*"error"/;
// Oversized frames keep their head (event type) and a scan for service_tier, not their body.
const HEAD_CHARS = 512;
const TAIL_CHARS = 4096;
const TERMINAL_HEAD =
  /(?:^|\n)event:\s*(?:response\.(?:completed|done|incomplete|failed)|error)\b|"type"\s*:\s*"(?:response\.(?:completed|done|incomplete|failed)|error)"/;
const SERVICE_TIER = /"service_tier"\s*:\s*"([^"]*)"/g;

/** An SSE tap, not a tee: reads at the consumer's pace, with cancellation and bounded buffering. */
export class FastRequestObservation {
  private buffer = "";
  /** Head of an oversized frame whose middle is being skipped. */
  private head?: string;
  /** Last unescaped service_tier seen in the current oversized frame. */
  private skippedTier?: string;
  private readonly record: FastRequestRecord;
  private readonly changed: () => void;
  private readonly now: () => number;

  constructor(record: FastRequestRecord, changed: () => void, now: () => number) {
    this.record = record;
    this.changed = changed;
    this.now = now;
  }

  private frame(frame: string): void {
    // After first output only terminal events matter; skip re-parsing every streamed delta.
    if (this.record.firstOutputMs !== undefined && !TERMINAL_EVENT.test(frame)) return;
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (
      this.record.firstOutputMs === undefined &&
      [
        "response.output_text.delta",
        "response.reasoning_summary_text.delta",
        "response.function_call_arguments.delta",
      ].includes(String(event.type))
    ) {
      this.record.firstOutputMs = this.now() - this.record.startedAt;
      this.changed();
    }
    if (!TERMINAL_TYPES.includes(String(event.type))) return;
    this.record.completedMs = this.now() - this.record.startedAt;
    this.record.responseTier = isRecord(event.response)
      ? observedTier(event.response.service_tier)
      : "unknown";
    this.changed();
  }

  /** Terminal events carry the whole response, which can exceed the frame limit on long turns. */
  private oversized(head: string): void {
    if (!TERMINAL_HEAD.test(head)) return;
    this.record.completedMs = this.now() - this.record.startedAt;
    // service_tier follows the (large) output array but precedes echoed request fields.
    this.record.responseTier = observedTier(this.skippedTier);
    this.changed();
  }

  private finishFrame(frame: string): void {
    const head = this.head;
    this.head = undefined;
    if (head === undefined && frame.length <= MAX_FRAME_CHARS) this.frame(frame);
    else {
      this.skip(frame);
      this.oversized(head ?? frame.slice(0, HEAD_CHARS));
    }
    this.skippedTier = undefined;
  }

  /** Remember the tier in text about to be dropped; JSON-escaped occurrences cannot match. */
  private skip(text: string): void {
    const tier = [...text.matchAll(SERVICE_TIER)].at(-1)?.[1];
    if (tier !== undefined) this.skippedTier = tier;
  }

  private feed(text: string): void {
    // Iterate bounded slices even when a transport returns one enormous chunk.
    for (let offset = 0; offset < text.length; offset += 4096) {
      this.buffer += text.slice(offset, offset + 4096);
      const delimiter = /\r?\n\r?\n/g;
      let start = 0;
      let match: RegExpExecArray | null;
      while ((match = delimiter.exec(this.buffer))) {
        const frame = this.buffer.slice(start, match.index);
        start = delimiter.lastIndex;
        this.finishFrame(frame);
      }
      if (start) this.buffer = this.buffer.slice(start);
      if (this.buffer.length > MAX_FRAME_CHARS) {
        this.head ??= this.buffer.slice(0, HEAD_CHARS);
        this.skip(this.buffer);
        // The kept tail preserves a split delimiter or service_tier match; it is rescanned later.
        this.buffer = this.buffer.slice(-TAIL_CHARS);
      }
    }
  }

  response(response: Response): Response {
    this.record.httpStatus = response.status;
    const isSSE = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
    if (!response.ok || !response.body || !isSSE) {
      this.changed();
      return response;
    }
    this.record.observedTransport = "sse";
    this.changed();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await reader.read();
          if (done) {
            this.feed(decoder.decode());
            if (this.head !== undefined || this.buffer.trim()) this.finishFrame(this.buffer);
            this.buffer = "";
            reader.releaseLock();
            controller.close();
          } else {
            this.feed(decoder.decode(value, { stream: true }));
            controller.enqueue(value);
          }
        } catch (error) {
          this.buffer = "";
          controller.error(error);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
      cancel: async (reason) => {
        this.buffer = "";
        await reader.cancel(reason);
        reader.releaseLock();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
