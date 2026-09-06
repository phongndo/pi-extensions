import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const OVERLAY_MODE = 0o600;

export type McpTransport = "http" | "sse" | "stdio";

export interface McpConfigPaths {
  sharedConfig: string;
  agentOverlay: string;
  projectMcpJson: string;
  projectPiMcpJson: string;
}

export interface ResolvedMcpServer {
  name: string;
  enabled: boolean;
  type: McpTransport;
  source: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface LoadedMcpConfig {
  servers: ResolvedMcpServer[];
  warnings: string[];
  overlayPath: string;
}

interface RawMcpServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  cwd?: unknown;
  url?: unknown;
  headers?: unknown;
  type?: unknown;
  disabled?: unknown;
  enabled?: unknown;
}

interface RawMcpFile {
  mcpServers?: unknown;
}

export function defaultMcpConfigPaths(
  cwd: string,
  options: { agentDir?: string; configHome?: string } = {},
): McpConfigPaths {
  const configHome =
    options.configHome ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const agentDir = options.agentDir ?? getAgentDir();
  return {
    sharedConfig: join(configHome, "mcp", "mcp.json"),
    agentOverlay: join(agentDir, "mcp.json"),
    projectMcpJson: join(cwd, ".mcp.json"),
    projectPiMcpJson: join(cwd, ".pi", "mcp.json"),
  };
}

export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => env[name] ?? "");
}

export function interpolateValue(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value === "string") return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((entry) => interpolateValue(entry, env));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = interpolateValue(entry, env);
    }
    return result;
  }
  return value;
}

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_PATTERN.test(name);
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
}

export function sanitizeName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "unnamed";
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

export function wrapToolSchema(inputSchema: unknown): Record<string, unknown> {
  if (!isRecord(inputSchema)) {
    return { type: "object", additionalProperties: true };
  }
  const clone = structuredClone(inputSchema);
  delete clone.$schema;
  if (typeof clone.type !== "string") clone.type = "object";
  return clone;
}

export async function loadMcpConfig(
  paths: McpConfigPaths,
  options: { projectTrusted: boolean; env?: NodeJS.ProcessEnv } = { projectTrusted: false },
): Promise<LoadedMcpConfig> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const merged = new Map<string, ResolvedMcpServer>();
  const files: Array<{ path: string; project: boolean }> = [
    { path: paths.sharedConfig, project: false },
    { path: paths.agentOverlay, project: false },
    { path: paths.projectMcpJson, project: true },
    { path: paths.projectPiMcpJson, project: true },
  ];

  for (const file of files) {
    if (file.project && !options.projectTrusted) continue;
    const parsed = await readMcpFile(file.path, warnings);
    if (!parsed) continue;
    for (const [name, raw] of Object.entries(parsed)) {
      const resolved = resolveServer(name, raw, file.path, env, warnings, merged.get(name));
      if (resolved) merged.set(name, resolved);
    }
  }

  return {
    servers: [...merged.values()],
    warnings,
    overlayPath: paths.agentOverlay,
  };
}

export async function setServerDisabled(
  overlayPath: string,
  name: string,
  disabled: boolean,
): Promise<void> {
  const current = (await readJsonObject(overlayPath)) ?? {};
  const servers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {};
  const existing = isRecord(servers[name]) ? { ...servers[name] } : {};
  existing.disabled = disabled;
  servers[name] = existing;
  await writeJsonAtomic(overlayPath, { ...current, mcpServers: servers });
}

async function readMcpFile(
  path: string,
  warnings: string[],
): Promise<Record<string, RawMcpServer> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    warnings.push(`Could not read ${path}: ${errorMessage(error)}`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    warnings.push(`Invalid JSON in ${path}: ${errorMessage(error)}`);
    return undefined;
  }

  if (!isRecord(parsed) || parsed.mcpServers === undefined) {
    warnings.push(`${path} is missing an mcpServers object.`);
    return undefined;
  }
  if (!isRecord(parsed.mcpServers)) {
    warnings.push(`${path} has an invalid mcpServers value.`);
    return undefined;
  }

  const servers: Record<string, RawMcpServer> = {};
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!isValidServerName(name)) {
      warnings.push(`Skipping invalid MCP server name "${name}" in ${path}.`);
      continue;
    }
    if (!isRecord(value)) {
      warnings.push(`Skipping MCP server "${name}" in ${path}: expected an object.`);
      continue;
    }
    servers[name] = value as RawMcpServer;
  }
  return servers;
}

function resolveServer(
  name: string,
  raw: RawMcpServer,
  source: string,
  env: NodeJS.ProcessEnv,
  warnings: string[],
  previous: ResolvedMcpServer | undefined,
): ResolvedMcpServer | undefined {
  const interpolated = interpolateValue(raw, env);
  if (!isRecord(interpolated)) return previous;

  const command = optionalString(interpolated.command) ?? previous?.command;
  const url = optionalString(interpolated.url) ?? previous?.url;
  const cwd = optionalString(interpolated.cwd) ?? previous?.cwd;
  const args = optionalStringArray(interpolated.args) ?? previous?.args;
  const serverEnv = optionalStringRecord(interpolated.env) ?? previous?.env;
  const headers = optionalStringRecord(interpolated.headers) ?? previous?.headers;
  const type = resolveTransport(interpolated.type, url, command, previous?.type);
  const enabled = resolveEnabled(interpolated, previous?.enabled ?? true);

  if (!type) {
    warnings.push(
      `Skipping MCP server "${name}" in ${source}: set command for stdio or url for HTTP.`,
    );
    return previous;
  }
  if (type === "stdio" && !command) {
    warnings.push(`Skipping MCP server "${name}" in ${source}: stdio servers require command.`);
    return previous;
  }
  if ((type === "http" || type === "sse") && !url) {
    warnings.push(`Skipping MCP server "${name}" in ${source}: ${type} servers require url.`);
    return previous;
  }

  const resolved: ResolvedMcpServer = {
    name,
    enabled,
    type,
    source,
  };
  if (command) resolved.command = command;
  if (args) resolved.args = args;
  if (serverEnv) resolved.env = serverEnv;
  if (cwd) resolved.cwd = cwd;
  if (url) resolved.url = url;
  if (headers) resolved.headers = headers;
  return resolved;
}

function resolveTransport(
  rawType: unknown,
  url: string | undefined,
  command: string | undefined,
  fallback: McpTransport | undefined,
): McpTransport | undefined {
  if (rawType === "http" || rawType === "sse" || rawType === "stdio") return rawType;
  if (typeof rawType === "string" && rawType.trim()) return undefined;
  if (url) return /\/sse(\?|$)/i.test(url) ? "sse" : "http";
  if (command) return "stdio";
  return fallback;
}

function resolveEnabled(raw: Record<string, unknown>, fallback: boolean): boolean {
  if (raw.disabled === true) return false;
  if (raw.disabled === false) return true;
  if (raw.enabled === false) return false;
  if (raw.enabled === true) return true;
  return fallback;
}

async function readJsonObject(path: string): Promise<RawMcpFile | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, payload, { encoding: "utf8", mode: OVERLAY_MODE });
  await chmod(tempPath, OVERLAY_MODE);
  await rename(tempPath, path);
  await chmod(path, OVERLAY_MODE);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

function optionalStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    result[key] = entry;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error !== null && typeof error === "object" && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
