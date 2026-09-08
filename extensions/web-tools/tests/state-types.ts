import type { BuiltCrawlRequest } from "../index.ts";

type Assert<T extends true> = T;
type Window = {
  cursorSkip: number;
  pageSize: number;
  maximumCharsPerPage: number;
};

export type CrawlStartNeedsRequest = Assert<
  Window & { kind: "start" } extends BuiltCrawlRequest ? false : true
>;
export type CrawlResumeNeedsId = Assert<
  Window & { kind: "resume" } extends BuiltCrawlRequest ? false : true
>;
export type CrawlCannotStartAndResume = Assert<
  Window & {
    kind: "start";
    request: Record<string, unknown>;
    crawlId: string;
  } extends BuiltCrawlRequest
    ? false
    : true
>;
