import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

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

interface McpServerBase {
  name: string;
  enabled: boolean;
  source: string;
}

/** A resolved transport always has its required endpoint, never mixed transport options. */
export type ResolvedMcpServer = McpServerBase &
  (
    | {
        type: "stdio";
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
        url?: never;
        headers?: never;
      }
    | {
        type: "http" | "sse";
        url: string;
        headers?: Record<string, string>;
        command?: never;
        args?: never;
        env?: never;
        cwd?: never;
      }
  );

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
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<LoadedMcpConfig> {
  const env = options.env ?? process.env;
  const warnings: string[] = [];
  const merged = new Map<string, ResolvedMcpServer>();
  const files = [paths.sharedConfig, paths.agentOverlay];

  for (const path of files) {
    const parsed = await readMcpFile(path, warnings);
    if (!parsed) continue;
    for (const [name, raw] of Object.entries(parsed)) {
      const resolved = resolveServer(name, raw, path, env, warnings, merged.get(name));
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
  // Canonicalize the parent before queue registration, so a new file keeps the
  // same queue key after creation (notably /var vs /private/var on macOS).
  await mkdir(dirname(overlayPath), { recursive: true });
  const queuePath = join(await realpath(dirname(overlayPath)), basename(overlayPath));
  await withFileMutationQueue(queuePath, async () => {
    const current = (await readJsonObject(overlayPath)) ?? {};
    if (current.mcpServers !== undefined && !isRecord(current.mcpServers))
      throw new Error(`Invalid mcpServers object in ${overlayPath}.`);
    const servers = isRecord(current.mcpServers) ? { ...current.mcpServers } : {};
    if (Object.hasOwn(servers, name) && !isRecord(servers[name]))
      throw new Error(`Invalid MCP server "${name}" in ${overlayPath}.`);
    const existing =
      Object.hasOwn(servers, name) && isRecord(servers[name]) ? { ...servers[name] } : {};
    existing.disabled = disabled;
    servers[name] = existing;
    await writeJsonAtomic(overlayPath, { ...current, mcpServers: servers });
  });
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

function isFlagOnlyOverlay(raw: Record<string, unknown>): boolean {
  return Object.keys(raw).every((key) => key === "disabled" || key === "enabled");
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

  if (isFlagOnlyOverlay(interpolated)) {
    if (!previous) {
      warnings.push(
        `Skipping MCP server "${name}" in ${source}: enable/disable overlay has no base server.`,
      );
      return undefined;
    }
    return { ...previous, enabled: resolveEnabled(interpolated, previous.enabled) };
  }

  const command = optionalString(interpolated.command);
  const url = optionalString(interpolated.url);
  const cwd = optionalString(interpolated.cwd);
  const args = optionalStringArray(interpolated.args);
  const serverEnv = optionalStringRecord(interpolated.env);
  const headers = optionalStringRecord(interpolated.headers);
  const type = resolveTransport(interpolated.type, url, command, undefined);
  const enabled = resolveEnabled(interpolated, previous?.enabled ?? true);

  if (!type) {
    warnings.push(
      `Skipping MCP server "${name}" in ${source}: set command for stdio or url for HTTP.`,
    );
    return previous;
  }
  if (type === "stdio") {
    if (!command) {
      warnings.push(`Skipping MCP server "${name}" in ${source}: stdio servers require command.`);
      return previous;
    }
    return {
      name,
      enabled,
      type,
      source,
      command,
      ...(args ? { args } : {}),
      ...(serverEnv ? { env: serverEnv } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }
  if (!url) {
    warnings.push(`Skipping MCP server "${name}" in ${source}: ${type} servers require url.`);
    return previous;
  }

  return { name, enabled, type, source, url, ...(headers ? { headers } : {}) };
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
    if (!isRecord(parsed)) throw new Error("Expected a JSON object.");
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not read ${path}: ${errorMessage(error)}`, { cause: error });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  // Only clean up a file we successfully created; never unlink somebody else's
  // file if exclusive creation fails.
  const file = await open(tempPath, "wx", OVERLAY_MODE);
  try {
    await file.writeFile(payload, "utf8");
    await file.chmod(OVERLAY_MODE);
    await file.close();
    await rename(tempPath, path);
  } finally {
    try {
      await file.close();
    } finally {
      await rm(tempPath, { force: true });
    }
  }
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
