/**
 * Pure formatting for the context-usage block. Turns a `ContextBreakdown` into
 * pre-colored text lines (theme color names, resolved by the TSX layer) in the
 * same shape `buildLines` uses in `src/quota-lines.ts`.
 */
import type { ContextBreakdown, ContextRow, GridCell, RowKey } from "./types";
import { finiteOrNull, nonNegative } from "../normalize";
import { padLabel } from "../tui-format";

/** Theme color names used by the context block. */
export type ContextTone =
  | "text"
  | "textMuted"
  | "borderSubtle"
  | "info"
  | "success"
  | "secondary"
  | "warning"
  | "error";

export interface Segment {
  text: string;
  fg: ContextTone;
  bold?: boolean;
}

export interface Line {
  segments: Segment[];
}

export interface BuildContextLinesOptions {
  /** Fallback shown when `breakdown.modelName` is null (e.g. raw providerID/modelID). */
  modelLabel?: string | null;
}

const GRID_ROWS = 6;
const GRID_MAX_WIDTH = 116;
const GRID_MAX_COLS = Math.floor(GRID_MAX_WIDTH / 2);
const LEGEND_LABEL_WIDTH = 24;
const LEGEND_COUNT_WIDTH = 9;
const LEGEND_PERCENT_WIDTH = 6;
const LEGEND_GAP = "   ";
const COLUMNS_PER_LEGEND_ROW = 3;

const CATEGORY_TONES: Record<RowKey, ContextTone> = {
  user: "info",
  agent: "success",
  reasoning: "secondary",
  tools: "warning",
  system: "textMuted",
  free: "borderSubtle",
};

const LEGEND_KEYS: readonly RowKey[] = ["user", "agent", "reasoning", "tools", "system", "free"];
const BAND_TONES: Record<"ok" | "warning" | "error", ContextTone> = {
  ok: "success",
  warning: "warning",
  error: "error",
};

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Locale-grouped integer token count; non-finite input renders as `0`. */
export function formatTokens(n: number): string {
  const value = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return value.toLocaleString("en-US");
}

/** USD currency string (e.g. `$0.42`); non-finite input renders as `$0.00`. */
export function formatMoney(n: number): string {
  const value = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return MONEY.format(value);
}

function glyphFor(fill: number): string {
  if (fill <= 0) return "░░";
  if (fill <= 0.25) return "▒▒";
  if (fill <= 0.75) return "▓▓";
  return "██";
}

function toneForRowKey(key: unknown): ContextTone {
  if (typeof key !== "string") return "borderSubtle";
  return CATEGORY_TONES[key as RowKey] ?? "borderSubtle";
}

/**
 * One-decimal percentage. A non-zero share that would round to `0.0%` reads as
 * "nothing at all", so anything under a tenth of a percent collapses to `<0.1%`.
 */
export function formatPercent(percent: number): string {
  const value = typeof percent === "number" && Number.isFinite(percent) ? percent : 0;
  if (value > 0 && value < 0.1) return "<0.1%";
  return `${Math.min(100, Math.max(0, value)).toFixed(1)}%`;
}

function headerMetric(breakdown: ContextBreakdown): string {
  if (breakdown.ready !== true) return "0 (0.0%)";
  const total = nonNegative(breakdown.total) ?? 0;
  const limit = nonNegative(breakdown.limit);
  if (limit === null || limit <= 0) return `${formatTokens(total)} tokens`;
  const percent = (total / limit) * 100;
  return `${formatTokens(total)} / ${formatTokens(limit)} tokens (${formatPercent(percent)})`;
}

function rowMap(breakdown: ContextBreakdown): Map<RowKey, ContextRow> {
  const map = new Map<RowKey, ContextRow>();
  const rows = Array.isArray(breakdown.rows) ? breakdown.rows : [];
  for (const row of rows) {
    if (row !== null && typeof row === "object" && typeof row.key === "string") {
      map.set(row.key, row);
    }
  }
  return map;
}

function legendEntry(key: RowKey, row: ContextRow | undefined, systemDerived: boolean): Segment[] {
  const baseLabel = row?.label ?? key;
  const label = key === "system" && systemDerived ? `${baseLabel} (derived)` : baseLabel;
  const tokens = nonNegative(row?.tokens);
  const percent = nonNegative(row?.percent);
  const percentText = percent === null ? "—" : formatPercent(percent);
  return [
    { text: "● ", fg: CATEGORY_TONES[key] },
    { text: padLabel(label, LEGEND_LABEL_WIDTH), fg: "text" },
    {
      text: (tokens === null ? "—" : formatTokens(tokens)).padStart(LEGEND_COUNT_WIDTH, " "),
      fg: "text",
    },
    { text: " ", fg: "text" },
    { text: percentText.padStart(LEGEND_PERCENT_WIDTH, " "), fg: "textMuted" },
  ];
}

function gridLines(breakdown: ContextBreakdown): Line[] {
  const grid = breakdown.grid;
  const cols = nonNegative(grid?.cols);
  if (cols === null || cols <= 0) return [];
  const requestedRows = nonNegative(grid?.rows);
  const rows = requestedRows !== null && requestedRows >= 1 ? Math.floor(requestedRows) : GRID_ROWS;
  const renderCols = Math.min(Math.floor(cols), GRID_MAX_COLS);
  const cells: readonly GridCell[] = Array.isArray(grid?.cells) ? grid.cells : [];

  const lines: Line[] = [];
  for (let r = 0; r < rows; r++) {
    const segments: Segment[] = [];
    for (let c = 0; c < renderCols; c++) {
      const cell = cells[r * cols + c] as GridCell | undefined;
      const fill = cell === undefined ? 0 : Math.min(1, Math.max(0, finiteOrNull(cell.fill) ?? 0));
      segments.push({ text: glyphFor(fill), fg: toneForRowKey(cell?.rowKey) });
    }
    lines.push({ segments });
  }
  return lines;
}

function headroomSegments(breakdown: ContextBreakdown): Segment[] {
  const usable = nonNegative(breakdown.headroom?.usable);
  if (usable === null || breakdown.ready !== true) return [];
  const free = nonNegative(breakdown.headroom?.free) ?? 0;
  const band = breakdown.headroom?.band;
  const tone = band === "warning" || band === "error" ? BAND_TONES[band] : BAND_TONES.ok;
  const segments: Segment[] = [
    { text: `Auto-compacts at ${formatTokens(usable)} · ${formatTokens(free)} headroom`, fg: tone },
  ];
  const cost = nonNegative(breakdown.cost);
  if (cost !== null && cost > 0) {
    segments.push({ text: ` · ${formatMoney(cost)} spent`, fg: "textMuted" });
  }
  return segments;
}

/** Renders a context breakdown as pre-colored lines; empty until the first response. */
export function buildContextLines(
  breakdown: ContextBreakdown,
  options: BuildContextLinesOptions = {},
): Line[] {
  const source = (breakdown ?? {}) as ContextBreakdown;
  const lines: Line[] = [];

  const modelName =
    typeof source.modelName === "string" && source.modelName !== "" ? source.modelName : null;
  const fallback =
    typeof options.modelLabel === "string" && options.modelLabel !== "" ? options.modelLabel : null;
  const name = modelName ?? fallback;

  const header: Segment[] = [];
  if (name !== null) {
    header.push({ text: name, fg: "text", bold: true });
    header.push({ text: " · ", fg: "textMuted" });
  }
  header.push({ text: headerMetric(source), fg: "text" });
  lines.push({ segments: header });

  if (source.ready !== true) {
    lines.push({ segments: [{ text: "awaiting first response", fg: "textMuted" }] });
  }

  const limit = nonNegative(source.limit);
  if (limit !== null && limit > 0) {
    lines.push(...gridLines(source));
  }

  const rows = rowMap(source);
  const derived = source.systemDerived === true;
  for (let i = 0; i < LEGEND_KEYS.length / 2; i++) {
    const leftKey = LEGEND_KEYS[i];
    const rightKey = LEGEND_KEYS[i + COLUMNS_PER_LEGEND_ROW];
    lines.push({
      segments: [
        ...legendEntry(leftKey, rows.get(leftKey), derived),
        { text: LEGEND_GAP, fg: "text" },
        ...legendEntry(rightKey, rows.get(rightKey), derived),
      ],
    });
  }

  const captured = nonNegative(source.systemCaptured);
  if (captured !== null) {
    const systemTokens = nonNegative(rows.get("system")?.tokens) ?? 0;
    const framing = Math.max(0, systemTokens - captured);
    const prefix = `↳ ${formatTokens(captured)} system prompt + `;
    const suffix = `${formatTokens(framing)} tools & framing`;
    lines.push({ segments: [{ text: prefix + suffix, fg: "textMuted" }] });
  }

  const headroom = headroomSegments(source);
  if (headroom.length > 0) lines.push({ segments: headroom });

  const pruned = nonNegative(source.prunedToolOutputs);
  if (pruned !== null && pruned > 0) {
    lines.push({
      segments: [
        { text: `${formatTokens(pruned)} tool outputs pruned from context`, fg: "textMuted" },
      ],
    });
  }

  return lines;
}
