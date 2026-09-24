import type { ProviderReport, UsageWindow } from "./types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_WIDTH = 8;
const PERCENT_WIDTH = 10;
const ABSOLUTES_WIDTH = 24;

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** "14:05" for a same-day reset, "Wed Sep 16" otherwise. */
export function formatReset(resetsAt: string, now: Date): string | null {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return null;
  const within24h = Math.abs(d.getTime() - now.getTime()) < DAY_MS;
  if (within24h) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function formatAge(fetchedAt: string, now: Date): string {
  const then = new Date(fetchedAt).getTime();
  const minutes = Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now.getTime() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function header(report: ProviderReport, now: Date): string {
  const parts: string[] = [report.source];
  if (report.stale) {
    parts.push(`stale ${formatAge(report.fetchedAt, now)} old`);
  }
  return `${report.displayName} (${parts.join(", ")})`;
}

function windowLine(report: ProviderReport, w: UsageWindow, now: Date, labelWidth: number): string {
  // Local estimates always carry the `~` marker, even when only absolutes are
  // known (percent is null): a bare em dash would hide that the row is estimated.
  const isEstimate = report.source === "local-estimate";
  const percent =
    w.usedPercent !== null
      ? `${isEstimate ? "~" : ""}${w.usedPercent}%`
      : isEstimate
        ? "~estimate"
        : "—";
  let line = `  ${w.label.padEnd(labelWidth)}${percent.padEnd(PERCENT_WIDTH)}`;

  if (w.used !== null && w.limit !== null) {
    const unit = /credit/i.test(w.label) ? "credits" : "reqs";
    line += `${formatNumber(w.used)} / ${formatNumber(w.limit)} ${unit}`.padEnd(ABSOLUTES_WIDTH);
  }
  if (w.resetsAt !== null) {
    const reset = formatReset(w.resetsAt, now);
    if (reset !== null) line += `resets ${reset}`;
  }
  return line.trimEnd();
}

/** Renders provider reports as a human-readable text table (spec §3.8). */
export function renderText(reports: ProviderReport[], opts?: { now?: Date }): string {
  const now = opts?.now ?? new Date();
  const labelWidth = Math.max(
    LABEL_WIDTH,
    ...reports.flatMap((report) => report.windows.map((w) => w.label.length + 1)),
  );
  const blocks = reports.map((report) => {
    if (report.source === "error") {
      return `⚠ ${report.displayName}: ${report.error ?? "unknown error"}`;
    }
    const lines = [header(report, now)];
    for (const w of report.windows) {
      lines.push(windowLine(report, w, now, labelWidth));
    }
    for (const [key, value] of Object.entries(report.extras)) {
      lines.push(`  ${key}: ${value}`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** Renders provider reports as pretty-printed JSON. */
export function renderJson(reports: ProviderReport[]): string {
  return JSON.stringify(reports, null, 2);
}
