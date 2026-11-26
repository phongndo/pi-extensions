import {
  truncateToWidth as clipToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

export function clip(line: string, width: number): string {
  const w = Math.max(1, width);
  // Most lines fit, and measuring a styled line is much cheaper than walking its graphemes.
  return visibleWidth(line) <= w ? line : clipToWidth(line, w, "…");
}

/**
 * Styled lines. Clipped lines keep one screen row each, so a collapsed row's height is known;
 * wrapped lines show everything, for expanded rows.
 */
export class Lines implements Component {
  lines: string[];
  wrap: boolean;

  constructor(lines: string[], wrap = false) {
    this.lines = lines;
    this.wrap = wrap;
  }

  render(width: number): string[] {
    const w = Math.max(1, width);
    if (!this.wrap) return this.lines.map((line) => clip(line, w));
    return this.lines.flatMap((line) =>
      line === "" ? [""] : wrapTextWithAnsi(line, w).map((part) => clip(part, w)),
    );
  }

  invalidate(): void {}
}

/**
 * One line `head + body + tail` that clips only `body`, so a long command or path keeps its status
 * mark and its `· …` notes.
 */
export class Fit implements Component {
  head: string;
  body: string;
  tail: string;

  constructor(head: string, body: string, tail: string) {
    this.head = head;
    this.body = body;
    this.tail = tail;
  }

  render(width: number): string[] {
    const room = width - visibleWidth(this.head) - visibleWidth(this.tail);
    if (visibleWidth(this.body) <= room) return [clip(this.head + this.body + this.tail, width)];
    if (room < 8) return [clip(this.head + this.body + this.tail, width)];
    return [this.head + clip(this.body, room) + this.tail];
  }

  invalidate(): void {}
}
