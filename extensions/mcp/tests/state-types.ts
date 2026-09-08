import type { ResolvedMcpServer } from "../config.ts";

type Assert<T extends true> = T;
type Base = { name: string; enabled: boolean; source: string };
export type TransportInvariants = [
  Assert<Base & { type: "stdio" } extends ResolvedMcpServer ? false : true>,
  Assert<Base & { type: "http" } extends ResolvedMcpServer ? false : true>,
  Assert<
    Base & { type: "stdio"; command: string; url: string } extends ResolvedMcpServer ? false : true
  >,
  Assert<
    Base & { type: "http"; url: string; command: string } extends ResolvedMcpServer ? false : true
  >,
];
