import { existsSync } from "node:fs";
import type { AdapterResult, UsageWindow } from "./types";
import { dbPath } from "./paths";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Minimal structural view of the node:sqlite API we rely on (kept dependency-optional). */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Sums an assistant message's token counts; returns null when no token field is present. */
function sumTokens(data: unknown): number | null {
  const record = asRecord(data);
  if (record === null) return null;
  const tokens = asRecord(record.tokens);
  if (tokens === null) return null;

  const total = toNum(tokens.total);
  if (total !== null) return total;

  let sum = 0;
  let found = false;
  for (const key of ["input", "output", "reasoning"]) {
    const n = toNum(tokens[key]);
    if (n !== null) {
      sum += n;
      found = true;
    }
  }
  const cache = asRecord(tokens.cache);
  if (cache !== null) {
    for (const key of ["read", "write"]) {
      const n = toNum(cache[key]);
      if (n !== null) {
        sum += n;
        found = true;
      }
    }
  }
  return found ? sum : null;
}

function isAssistantForProvider(data: unknown, providerId: string): boolean {
  const record = asRecord(data);
  if (record === null) return false;
  return record.role === "assistant" && record.providerID === providerId;
}

function makeWindow(kind: "5h" | "weekly", label: string, used: number): UsageWindow {
  return {
    kind,
    label,
    usedPercent: null,
    used,
    limit: null,
    remaining: null,
    resetsAt: null,
    status: "ok",
  };
}

/**
 * Best-effort local usage estimate read from opencode's SQLite database.
 *
 * The DB is opened READ-ONLY and every step is defensive: a missing file, an
 * absent sqlite runtime, schema drift, malformed rows, or no matching rows all
 * yield null. This function never throws.
 */
export async function localEstimate(
  providerId: string,
  env?: NodeJS.ProcessEnv,
): Promise<AdapterResult | null> {
  let db: SqliteDatabase | null = null;
  try {
    const file = dbPath(env);
    if (!existsSync(file)) return null;

    let Ctor: DatabaseSyncCtor | null = null;
    try {
      const mod = await import("node:sqlite");
      if (typeof mod.DatabaseSync === "function") {
        Ctor = mod.DatabaseSync as unknown as DatabaseSyncCtor;
      }
    } catch {
      return null;
    }
    if (Ctor === null) return null;

    db = new Ctor(file, { readOnly: true });

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (!tables.some((row) => asRecord(row)?.name === "message")) return null;

    const columns = db.prepare("PRAGMA table_info(message)").all();
    const columnNames = new Set(
      columns
        .map((column) => asRecord(column)?.name)
        .filter((name): name is string => typeof name === "string"),
    );
    if (!columnNames.has("data") || !columnNames.has("time_created")) return null;

    const now = Date.now();
    const weeklyCutoff = now - 7 * DAY_MS;
    const rows = db
      .prepare("SELECT time_created AS time, data AS data FROM message WHERE time_created >= ?")
      .all(weeklyCutoff);

    const candidates: Array<{ time: number; data: unknown }> = [];
    for (const row of rows) {
      const record = asRecord(row);
      if (record === null) continue;
      const time = toNum(record.time);
      if (time === null) continue;
      const raw = record.data;
      if (typeof raw !== "string") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isAssistantForProvider(parsed, providerId)) continue;
      candidates.push({ time, data: parsed });
    }
    if (candidates.length === 0) return null;

    const anyTokens = candidates.some((candidate) => sumTokens(candidate.data) !== null);
    const fiveHourCutoff = now - 5 * HOUR_MS;

    let used5h = 0;
    let usedWeekly = 0;
    for (const candidate of candidates) {
      const value = anyTokens ? (sumTokens(candidate.data) ?? 0) : 1;
      usedWeekly += value;
      if (candidate.time >= fiveHourCutoff) used5h += value;
    }

    return {
      windows: [
        makeWindow("5h", "5-hour (local estimate)", used5h),
        makeWindow("weekly", "Weekly (local estimate)", usedWeekly),
      ],
      extras: {
        source: "opencode.db",
        metric: anyTokens ? "tokens" : "messages",
      },
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close failures
    }
  }
}
