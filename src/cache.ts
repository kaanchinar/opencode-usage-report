import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AdapterResult } from "./types";
import { pluginStateDir } from "./paths";

export interface CacheEntry {
  fetchedAt: string;
  result: AdapterResult;
}

/** <pluginStateDir>/cache-<providerId>.json */
function cacheFilePath(providerId: string, env?: NodeJS.ProcessEnv): string {
  return join(pluginStateDir(env), `cache-${providerId}.json`);
}

/**
 * Reads a cached adapter result. Returns null when the file is missing, unreadable,
 * corrupt, or structurally invalid. `fresh` is true while age <= ttlSeconds
 * (a negative TTL always reports stale).
 */
export async function readCache(
  providerId: string,
  ttlSeconds: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ entry: CacheEntry; fresh: boolean } | null> {
  try {
    const raw = await readFile(cacheFilePath(providerId, env), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const candidate = parsed as { fetchedAt?: unknown; result?: unknown };
    if (typeof candidate.fetchedAt !== "string") return null;
    if (candidate.result === null || typeof candidate.result !== "object") return null;

    const result = candidate.result as { windows?: unknown };
    if (!Array.isArray(result.windows)) return null;

    const fetchedAtMs = new Date(candidate.fetchedAt).getTime();
    if (Number.isNaN(fetchedAtMs)) return null;
    const ageSeconds = (Date.now() - fetchedAtMs) / 1000;

    return {
      entry: { fetchedAt: candidate.fetchedAt, result: result as AdapterResult },
      fresh: ageSeconds <= ttlSeconds,
    };
  } catch {
    return null;
  }
}

/**
 * Persists an adapter result atomically: writes a temp file next to the target
 * then renames it into place. Best-effort: never throws.
 */
export async function writeCache(
  providerId: string,
  result: AdapterResult,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const dir = pluginStateDir(env);
    await mkdir(dir, { recursive: true });
    const file = cacheFilePath(providerId, env);
    const entry: CacheEntry = { fetchedAt: new Date().toISOString(), result };
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    await rename(tmp, file);
  } catch {
    // Cache writes are best-effort; callers fall back to a live fetch.
  }
}

/**
 * Returns a stable session id, creating and persisting a UUID on first use.
 * Best-effort: if the id cannot be persisted, a fresh id is still returned.
 */
export async function ensureSessionId(env?: NodeJS.ProcessEnv): Promise<string> {
  const dir = pluginStateDir(env);
  const file = join(dir, "session-id");

  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing !== "") return existing;
  } catch {
    // Missing/unreadable -> create below.
  }

  const id = randomUUID();
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, id, "utf8");
  } catch {
    // Best-effort persistence; return the generated id regardless.
  }
  return id;
}
