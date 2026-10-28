import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { withPreferenceLock, writePreferenceJson } from "../../src/preference-file.ts";

export const FAST_MODE_STATE_PATH = join(getAgentDir(), "fast-mode.json");

interface FastModeState {
  version: 1;
  enabled: boolean;
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
  assertOwned?: () => void,
): Promise<void> {
  try {
    await writePreferenceJson(path, { version: 1, enabled } satisfies FastModeState, assertOwned);
  } catch (error) {
    throw new Error(`Could not save fast-mode state at ${path}.`, { cause: error });
  }
}

async function updateFastMode(value: boolean | undefined, path: string): Promise<boolean> {
  return withPreferenceLock(path, async (canonical, assertOwned) => {
    const current = await loadFastMode(canonical);
    const enabled = value ?? !current;
    if (enabled !== current) await saveFastMode(enabled, canonical, assertOwned);
    return enabled;
  });
}

/** Idempotent explicit writes share the toggle's inter-process lock. */
export async function setFastMode(
  enabled: boolean,
  path: string = FAST_MODE_STATE_PATH,
): Promise<boolean> {
  return updateFastMode(enabled, path);
}

export async function toggleFastMode(path: string = FAST_MODE_STATE_PATH): Promise<boolean> {
  return updateFastMode(undefined, path);
}
