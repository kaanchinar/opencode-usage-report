import type { UsageWindow, WindowKind } from "./types";

/** Accepts a number or a numeric string; anything else (including NaN/Infinity) yields null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Accepts an ISO date string, epoch seconds (< 1e12) or epoch milliseconds (>= 1e12).
 * Returns a normalized ISO-8601 string, or null when the value cannot be parsed.
 */
export function toISODate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Returns the first non-null/undefined value of obj[keys]; non-plain-object input yields undefined. */
export function pick(obj: unknown, ...keys: string[]): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined) return value;
  }
  return undefined;
}

/** Converts a 0-1 ratio into a 0-100 percent, clamped to [0,100] and rounded to 1 decimal. */
export function ratioToPercent(ratio: number): number {
  const rounded = Math.round(ratio * 1000) / 10;
  return Math.min(100, Math.max(0, rounded));
}

/** Builds a window from tolerant count fields, deriving usedPercent only when used and a positive limit are known. */
export function windowFromCounts(
  kind: WindowKind,
  label: string,
  detail: { limit?: unknown; used?: unknown; remaining?: unknown; reset?: unknown },
): UsageWindow {
  const used = toNumber(detail.used);
  const limit = toNumber(detail.limit);
  const remaining = toNumber(detail.remaining);
  const usedPercent =
    used !== null && limit !== null && limit > 0 ? Math.round((used / limit) * 100) : null;
  return {
    kind,
    label,
    usedPercent,
    used,
    limit,
    remaining,
    resetsAt: toISODate(detail.reset),
    status: "ok",
  };
}
