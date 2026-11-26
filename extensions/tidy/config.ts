import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withPreferenceLock, writePreferenceJson } from "../../src/preference-file.ts";

export const TIDY_CONFIG_PATH = join(getAgentDir(), "tidy.json");

export interface TidyConfig {
  /** Tool rows, the hidden thinking label, the `›` marker and the prose section, together. */
  enabled: boolean;
}

export const DEFAULT_CONFIG: TidyConfig = { enabled: true };

export function normalizeConfig(raw: unknown): TidyConfig {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof value.enabled === "boolean") return { enabled: value.enabled };
  // Earlier versions saved `tools`; keep an earlier `/tidy off`.
  if (typeof value.tools === "boolean") return { enabled: value.tools };
  return { ...DEFAULT_CONFIG };
}

export async function loadConfig(path = TIDY_CONFIG_PATH): Promise<TidyConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: TidyConfig, path = TIDY_CONFIG_PATH): Promise<void> {
  await withPreferenceLock(path, (canonical, assertOwned) =>
    writePreferenceJson(canonical, config, assertOwned),
  );
}
