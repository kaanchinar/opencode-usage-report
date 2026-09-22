/**
 * Pure formatting helpers for the TUI sidebar usage panel. No JSX, no Solid
 * imports (the only module dependency is the shared `DEFAULT_OPTIONS`).
 */
import { DEFAULT_OPTIONS } from "./report.js";

export type ToneName = "success" | "warning" | "error" | "textMuted";

export const BAR_MIN_WIDTH = 4;
export const BAR_MAX_WIDTH = 40;
export const DEFAULT_BAR_WIDTH = 14;
export const MIN_REFRESH_INTERVAL_SECONDS = 5;
export const MAX_REFRESH_INTERVAL_SECONDS = 3600;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 60;

/**
 * Renders a fixed-width progress bar. `percent` is clamped to 0-100 and rounded
 * to the nearest filled cell; `null` (or any non-finite value) renders an empty
 * bar. Width is floored and clamped to 4..40 cells so it can never throw or
 * allocate an unbounded string.
 */
export function bar(percent: number | null, width = DEFAULT_BAR_WIDTH): string {
  const requested = Number.isFinite(width) ? Math.floor(width) : DEFAULT_BAR_WIDTH;
  const w = Math.min(BAR_MAX_WIDTH, Math.max(BAR_MIN_WIDTH, requested));
  if (percent === null || !Number.isFinite(percent)) return "░".repeat(w);
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * w);
  return "█".repeat(filled) + "░".repeat(w - filled);
}

/**
 * Maps a window's usage to a theme color name. Rate-limited/frozen windows are
 * always an error, unknown percentages are muted, and the remaining bands are
 * 80%+ (error), 50%+ (warning) and everything below (success).
 */
export function toneFor(
  percent: number | null,
  status: "ok" | "rate-limited" | "frozen" | "unknown",
): ToneName {
  if (status === "rate-limited" || status === "frozen") return "error";
  if (percent === null || !Number.isFinite(percent)) return "textMuted";
  if (percent >= 80) return "error";
  if (percent >= 50) return "warning";
  return "success";
}

/**
 * Compact countdown to an ISO reset time. Returns `null` for missing/invalid
 * input, `"now"` when less than a minute remains, and otherwise the largest
 * non-zero day/hour/minute units (e.g. `"4d 9h 33m"`, `"3h 33m"`, `"12m"`).
 */
export function countdown(resetsAt: string | null, now: Date): string | null {
  if (resetsAt === null) return null;
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const deltaMs = target - now.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 60_000) return "now";

  const totalMinutes = Math.floor(deltaMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const days = totalDays;
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "now";
}

/** Human label for a window kind, falling back to the provider-supplied label. */
export function windowLabel(
  kind: "5h" | "daily" | "weekly" | "monthly" | "other",
  fallback: string,
): string {
  switch (kind) {
    case "5h":
      return "5h limit";
    case "daily":
      return "Daily limit";
    case "weekly":
      return "Weekly limit";
    case "monthly":
      return "Monthly limit";
    default:
      return fallback;
  }
}

/**
 * Prefers a percentage, then used/limit, then a lone used count, then a dash.
 * Fields are treated as unknown so `undefined` (or non-number junk) never
 * reaches `toLocaleString()`.
 */
export function percentText(w: {
  usedPercent?: number | null;
  used?: number | null;
  limit?: number | null;
  source?: string;
}): string {
  const usedPercent = w.usedPercent;
  if (typeof usedPercent === "number" && Number.isFinite(usedPercent)) {
    return `${Math.round(usedPercent)}%`;
  }
  const used = w.used;
  const limit = w.limit;
  const usedIsNumber = typeof used === "number" && Number.isFinite(used);
  const limitIsNumber = typeof limit === "number" && Number.isFinite(limit);
  if (usedIsNumber && limitIsNumber) {
    return `${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")}`;
  }
  if (usedIsNumber) {
    return `~${used.toLocaleString("en-US")}`;
  }
  return "—";
}

/**
 * Compact age of an ISO timestamp relative to `now` (e.g. `"14m"`, `"2h"`,
 * `"3d"`). `null`/invalid input yields `null`; future timestamps floor to `"0s"`.
 */
export function formatAge(iso: string | null, now: Date): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const ageMs = Math.max(0, now.getTime() - then);

  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export interface ResolvedTuiOptions {
  providers?: string[];
  cacheTtlSeconds: number;
  thresholdPercent: number;
  refreshIntervalSeconds: number;
  barWidth: number;
}

/** Coerces a loosely-typed value into a finite number, or null. */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Defensive option coercion; malformed values fall back to defaults.
 * `barWidth` is floored and clamped to 4..40; `refreshIntervalSeconds` is
 * rounded and clamped to 5..3600 so the timer can never hot-loop or overflow.
 */
export function coerceTuiOptions(
  raw: Record<string, unknown> | undefined,
): ResolvedTuiOptions {
  const opts: ResolvedTuiOptions = {
    cacheTtlSeconds: DEFAULT_OPTIONS.cacheTtlSeconds,
    thresholdPercent: DEFAULT_OPTIONS.thresholdPercent,
    refreshIntervalSeconds: DEFAULT_REFRESH_INTERVAL_SECONDS,
    barWidth: DEFAULT_BAR_WIDTH,
  };
  if (raw === undefined) return opts;

  if (Array.isArray(raw.providers)) {
    const ids = raw.providers.filter((id): id is string => typeof id === "string");
    if (ids.length > 0) opts.providers = ids;
  } else if (raw.providers === null) {
    opts.providers = undefined;
  }

  const ttl = toFiniteNumber(raw.cacheTtlSeconds);
  if (ttl !== null && ttl >= 0) opts.cacheTtlSeconds = ttl;

  const threshold = toFiniteNumber(raw.thresholdPercent);
  if (threshold !== null) opts.thresholdPercent = threshold;

  const interval = toFiniteNumber(raw.refreshIntervalSeconds);
  if (interval !== null) {
    opts.refreshIntervalSeconds = Math.min(
      MAX_REFRESH_INTERVAL_SECONDS,
      Math.max(MIN_REFRESH_INTERVAL_SECONDS, Math.round(interval)),
    );
  }

  const width = toFiniteNumber(raw.barWidth);
  if (width !== null) {
    opts.barWidth = Math.min(BAR_MAX_WIDTH, Math.max(BAR_MIN_WIDTH, Math.floor(width)));
  }

  return opts;
}
