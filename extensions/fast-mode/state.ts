import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const FAST_MODE_STATE_PATH = join(getAgentDir(), "fast-mode.json");

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
// A toggle only holds the lock for one state-file read and atomic write. Keep a much
// larger cross-host lease so crashed hosts recover without expiring normal operations.
const FOREIGN_LOCK_LEASE_MS = 5 * 60_000;
const LOCK_OWNER_PREFIX = "owner.";
const LOCK_OWNER_SUFFIX = ".json";
const LEGACY_LOCK_OWNER_FILE = "owner.json";
const PROCESS_IDENTITY_CACHE_MS = 500;
const CURRENT_HOST_ID = hostname();
const execFileAsync = promisify(execFile);

interface ProcessInstance {
  identity: string;
  zombie: boolean;
}

const processIdentityCache = new Map<
  number,
  { instance: ProcessInstance | undefined; expiresAt: number }
>();

interface FastModeState {
  version: 1;
  enabled: boolean;
}

interface LegacyFastModeLockOwner {
  version: 1;
  pid: number;
  createdAt: number;
  token: string;
}

interface FastModeLockOwnerV2 {
  version: 2;
  pid: number;
  createdAt: number;
  token: string;
  processStartId: string;
}

interface FastModeLockOwner {
  version: 3;
  pid: number;
  createdAt: number;
  token: string;
  processStartId: string;
  hostId: string;
}

type ParsedFastModeLockOwner = LegacyFastModeLockOwner | FastModeLockOwnerV2 | FastModeLockOwner;

interface FastModeLockMarker {
  markerName: string;
  owner: ParsedFastModeLockOwner | undefined;
}

interface FastModeLockInspection {
  markers: FastModeLockMarker[];
  isEmpty: boolean;
  hasUnknownEntries: boolean;
  modifiedAt: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseState(value: unknown): FastModeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Fast-mode state must be a JSON object.");
  }
  const state = value as Record<string, unknown>;
  if (state.version !== 1) {
    throw new Error(`Unsupported fast-mode state version: ${String(state.version)}.`);
  }
  if (typeof state.enabled !== "boolean") {
    throw new Error("Fast-mode state enabled must be a boolean.");
  }
  return { version: 1, enabled: state.enabled };
}

export async function loadFastMode(path: string = FAST_MODE_STATE_PATH): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw new Error(`Could not read fast-mode state at ${path}.`, { cause: error });
  }

  try {
    return parseState(JSON.parse(raw)).enabled;
  } catch (error) {
    throw new Error(
      `Invalid fast-mode state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

export async function saveFastMode(
  enabled: boolean,
  path: string = FAST_MODE_STATE_PATH,
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, enabled } satisfies FastModeState, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not save fast-mode state at ${path}.`, { cause: error });
  }
}

function parseLockOwner(value: unknown): ParsedFastModeLockOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    typeof owner.pid !== "number" ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.createdAt !== "number" ||
    !Number.isFinite(owner.createdAt) ||
    owner.createdAt <= 0 ||
    typeof owner.token !== "string" ||
    owner.token.length === 0
  ) {
    return undefined;
  }
  if (owner.version === 1 && owner.processStartId === undefined) {
    return {
      version: 1,
      pid: owner.pid,
      createdAt: owner.createdAt,
      token: owner.token,
    };
  }
  if (
    owner.version === 2 &&
    typeof owner.processStartId === "string" &&
    owner.processStartId.length > 0
  ) {
    return {
      version: 2,
      pid: owner.pid,
      createdAt: owner.createdAt,
      token: owner.token,
      processStartId: owner.processStartId,
    };
  }
  if (
    owner.version === 3 &&
    typeof owner.processStartId === "string" &&
    owner.processStartId.length > 0 &&
    typeof owner.hostId === "string" &&
    owner.hostId.length > 0
  ) {
    return {
      version: 3,
      pid: owner.pid,
      createdAt: owner.createdAt,
      token: owner.token,
      processStartId: owner.processStartId,
      hostId: owner.hostId,
    };
  }
  return undefined;
}

function lockOwnerMarkerName(token: string): string {
  return `${LOCK_OWNER_PREFIX}${token}${LOCK_OWNER_SUFFIX}`;
}

function lockOwnerMarkerToken(markerName: string): string | undefined {
  if (!markerName.startsWith(LOCK_OWNER_PREFIX) || !markerName.endsWith(LOCK_OWNER_SUFFIX)) {
    return undefined;
  }
  const token = markerName.slice(LOCK_OWNER_PREFIX.length, -LOCK_OWNER_SUFFIX.length);
  return token.length > 0 ? token : undefined;
}

async function inspectLock(lockPath: string): Promise<FastModeLockInspection | undefined> {
  let entries: string[];
  try {
    entries = await readdir(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not inspect fast-mode lock at ${lockPath}.`, { cause: error });
  }

  let modifiedAt: number;
  try {
    modifiedAt = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Could not inspect fast-mode lock at ${lockPath}.`, { cause: error });
  }

  const markerNames = entries.filter(
    (entry) => entry === LEGACY_LOCK_OWNER_FILE || lockOwnerMarkerToken(entry) !== undefined,
  );
  const markers: FastModeLockMarker[] = [];
  for (const markerName of markerNames) {
    let raw: string;
    try {
      raw = await readFile(join(lockPath, markerName), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error(`Could not inspect fast-mode lock at ${lockPath}.`, { cause: error });
    }

    let owner: ParsedFastModeLockOwner | undefined;
    try {
      owner = parseLockOwner(JSON.parse(raw));
    } catch {
      owner = undefined;
    }
    const markerToken = lockOwnerMarkerToken(markerName);
    if (markerToken !== undefined && owner?.token !== markerToken) owner = undefined;
    markers.push({ markerName, owner });
  }

  return {
    markers,
    isEmpty: entries.length === 0,
    hasUnknownEntries: markerNames.length !== entries.length,
    modifiedAt,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    if (isNodeError(error) && error.code === "EPERM") return true;
    throw new Error(`Could not inspect fast-mode lock owner process ${pid}.`, { cause: error });
  }
}

async function readProcessInstance(pid: number): Promise<ProcessInstance | undefined> {
  if (process.platform === "linux" || process.platform === "android") {
    try {
      const [processStat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const commandEnd = processStat.lastIndexOf(")");
      const fields =
        commandEnd >= 0
          ? processStat
              .slice(commandEnd + 1)
              .trim()
              .split(/\s+/)
          : [];
      const state = fields[0];
      const startTicks = fields[19];
      return startTicks
        ? { identity: `linux:${bootId.trim()}:${startTicks}`, zombie: state === "Z" }
        : undefined;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new Error(`Could not inspect process ${pid}.`, { cause: error });
      }
    }
  }

  if (
    process.platform === "linux" ||
    process.platform === "android" ||
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd" ||
    process.platform === "sunos" ||
    process.platform === "aix" ||
    process.platform === "haiku" ||
    process.platform === "cygwin" ||
    process.platform === "netbsd"
  ) {
    try {
      const { stdout } = await execFileAsync(
        "ps",
        ["-o", "state=", "-o", "lstart=", "-p", String(pid)],
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        },
      );
      const [state, ...startedAtParts] = stdout.trim().split(/\s+/);
      const startedAt = startedAtParts.join(" ");
      return state && startedAt
        ? {
            identity: `${process.platform}:${startedAt}`,
            zombie: state.startsWith("Z"),
          }
        : undefined;
    } catch (error) {
      if (!isProcessAlive(pid)) return undefined;
      throw new Error(`Could not inspect process ${pid}.`, { cause: error });
    }
  }

  if (process.platform === "win32") {
    try {
      const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8" },
      );
      const startedAt = stdout.trim();
      return startedAt ? { identity: `win32:${startedAt}`, zombie: false } : undefined;
    } catch (error) {
      if (!isProcessAlive(pid)) return undefined;
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new Error(`Could not inspect process ${pid}.`, { cause: error });
    }
  }

  throw new Error(`Unsupported platform for fast-mode locking: ${process.platform}.`);
}

async function getProcessInstance(pid: number): Promise<ProcessInstance | undefined> {
  const cached = processIdentityCache.get(pid);
  if (cached && cached.expiresAt > Date.now()) return cached.instance;
  const instance = await readProcessInstance(pid);
  processIdentityCache.set(pid, {
    instance,
    expiresAt: Date.now() + PROCESS_IDENTITY_CACHE_MS,
  });
  return instance;
}

async function isLockOwnerAbandoned(
  owner: ParsedFastModeLockOwner,
  foreignLockExpired: boolean,
): Promise<boolean> {
  if (owner.version === 3) {
    // Hostnames are only a foreign-host hint: distinct hosts and PID namespaces can share one.
    // Treat the owner as local only when its exact process instance exists in this namespace.
    if (owner.hostId !== CURRENT_HOST_ID || !isProcessAlive(owner.pid)) {
      return foreignLockExpired;
    }
    const processInstance = await getProcessInstance(owner.pid);
    if (processInstance?.identity !== owner.processStartId) return foreignLockExpired;
    return processInstance.zombie;
  }

  if (!isProcessAlive(owner.pid)) return true;
  const processInstance = await getProcessInstance(owner.pid);
  if (processInstance?.zombie) return true;
  if (owner.version === 1) return false;
  return processInstance !== undefined && processInstance.identity !== owner.processStartId;
}

async function isLockAbandoned(inspection: FastModeLockInspection): Promise<boolean> {
  if (inspection.hasUnknownEntries) return false;
  const age = Date.now() - inspection.modifiedAt;
  const oldEnough = age >= LOCK_INITIALIZATION_GRACE_MS;
  const foreignLockExpired = age >= FOREIGN_LOCK_LEASE_MS;
  if (inspection.markers.length === 0) return inspection.isEmpty && oldEnough;

  for (const marker of inspection.markers) {
    if (marker.owner) {
      if (!(await isLockOwnerAbandoned(marker.owner, foreignLockExpired))) return false;
    } else if (!oldEnough) {
      return false;
    }
  }
  return true;
}

async function removeEmptyLockDirectory(lockPath: string): Promise<boolean> {
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    if (isNodeError(error) && (error.code === "ENOTEMPTY" || error.code === "EEXIST")) {
      return false;
    }
    throw new Error(`Could not remove fast-mode lock directory at ${lockPath}.`, {
      cause: error,
    });
  }
}

async function reclaimAbandonedLock(lockPath: string): Promise<boolean> {
  const inspection = await inspectLock(lockPath);
  if (!inspection) return true;
  if (!(await isLockAbandoned(inspection))) return false;

  for (const marker of inspection.markers) {
    try {
      await rm(join(lockPath, marker.markerName));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return true;
      throw new Error(`Could not reclaim abandoned fast-mode lock at ${lockPath}.`, {
        cause: error,
      });
    }
  }
  return removeEmptyLockDirectory(lockPath);
}

async function failLockInitialization(
  lockPath: string,
  markerPath: string,
  cause: unknown,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    await rm(markerPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") cleanupErrors.push(error);
  }
  try {
    await removeEmptyLockDirectory(lockPath);
  } catch (error) {
    cleanupErrors.push(error);
  }

  const message = `Could not initialize fast-mode lock at ${lockPath}.`;
  if (cleanupErrors.length > 0) throw new AggregateError([cause, ...cleanupErrors], message);
  throw new Error(message, { cause });
}

async function releaseFastModeLock(lockPath: string, markerName: string): Promise<void> {
  try {
    await rm(join(lockPath, markerName));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`Fast-mode lock ownership was lost at ${lockPath}.`);
    }
    throw new Error(`Could not release fast-mode lock at ${lockPath}.`, { cause: error });
  }

  // A contender can finish initializing in this directory after its predecessor was reaped.
  // Its distinct marker now owns the lock, so only remove the directory when it is still empty.
  await removeEmptyLockDirectory(lockPath);
}

async function acquireFastModeLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const processInstance = await getProcessInstance(process.pid);
  const processStartId = processInstance?.identity;
  if (!processStartId) {
    throw new Error(`Could not determine the current process identity for ${path}.`);
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw new Error(`Could not lock fast-mode state at ${path}.`, { cause: error });
      }
      if (await reclaimAbandonedLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the fast-mode state lock at ${path}.`);
      }
      await delay(LOCK_RETRY_MS);
      continue;
    }

    const owner = {
      version: 3,
      pid: process.pid,
      createdAt: Date.now(),
      token: randomUUID(),
      processStartId,
      hostId: CURRENT_HOST_ID,
    } satisfies FastModeLockOwner;
    const markerName = lockOwnerMarkerName(owner.token);
    const markerPath = join(lockPath, markerName);
    const temporaryMarkerPath = `${lockPath}.${owner.token}.owner.tmp`;
    try {
      await writeFile(temporaryMarkerPath, `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryMarkerPath, markerPath);
    } catch (error) {
      let publicationError: unknown = error;
      try {
        await rm(temporaryMarkerPath, { force: true });
      } catch (cleanupError) {
        publicationError = new AggregateError(
          [error, cleanupError],
          `Could not clean up temporary fast-mode lock marker ${temporaryMarkerPath}.`,
        );
      }
      if (isNodeError(error) && error.code === "ENOENT" && publicationError === error) continue;
      await failLockInitialization(lockPath, markerPath, publicationError);
    }

    let entries: string[] = [];
    try {
      entries = await readdir(lockPath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      await failLockInitialization(lockPath, markerPath, error);
    }
    if (entries.length !== 1 || entries[0] !== markerName) {
      try {
        await rm(markerPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw new Error(`Could not withdraw fast-mode lock marker at ${markerPath}.`, {
            cause: error,
          });
        }
      }
      await removeEmptyLockDirectory(lockPath);
      await delay(LOCK_RETRY_MS);
      continue;
    }

    return () => releaseFastModeLock(lockPath, markerName);
  }
}

export async function toggleFastMode(path: string = FAST_MODE_STATE_PATH): Promise<boolean> {
  const release = await acquireFastModeLock(path);
  try {
    const enabled = !(await loadFastMode(path));
    await saveFastMode(enabled, path);
    return enabled;
  } finally {
    await release();
  }
}
