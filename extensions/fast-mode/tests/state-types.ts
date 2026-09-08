import type { FastStateSnapshot } from "../monitor.ts";

type Assert<T extends true> = T;
export type SnapshotInvariant = Assert<
  { enabled: true; error: string } extends FastStateSnapshot ? false : true
>;
