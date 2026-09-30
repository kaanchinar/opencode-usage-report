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

/** Finite number or null; numeric strings are not coerced. */
export function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Finite number >= 0 or null. */
export function nonNegative(value: unknown): number | null {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

/** Plain-object guard: null and arrays are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant string coercion; null and undefined become "". */
export function safeString(value: unknown): string {
  return String(value ?? "");
}
