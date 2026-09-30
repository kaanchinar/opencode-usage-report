import type { ContextRow, GridCell, RowKey } from "./types";
import { finiteOrNull } from "../normalize";

const GRID_ROWS_DEFAULT = 6;
const GRID_COLS_DEFAULT = 8;
const CATEGORY_ORDER: readonly RowKey[] = ["user", "agent", "reasoning", "tools", "system"];

export interface BuildGridInput {
  rows: readonly ContextRow[];
  limit: number | null;
  total: number | null;
  cols?: number | null;
  gridRows?: number | null;
}

function rowTokens(rows: readonly ContextRow[], key: RowKey): number {
  if (!Array.isArray(rows)) return 0;
  for (const row of rows) {
    if (row !== null && typeof row === "object" && row.key === key) {
      const tokens = finiteOrNull(row.tokens);
      return tokens !== null && tokens > 0 ? tokens : 0;
    }
  }
  return 0;
}

function categoryAt(
  ranges: readonly { key: RowKey; start: number; end: number }[],
  position: number,
): RowKey | null {
  for (const range of ranges) {
    if (position >= range.start && position < range.end) return range.key;
  }
  return null;
}

/**
 * Lays out the grid of square cells from the five measured rows. Cells are in
 * row-major order; only the cell straddling `total` is partial and free space
 * is never materialised.
 */
export function buildGrid(input: BuildGridInput): {
  cols: number;
  rows: number;
  cells: GridCell[];
} {
  const cols = finiteOrNull(input.cols) ?? GRID_COLS_DEFAULT;
  const rows = finiteOrNull(input.gridRows) ?? GRID_ROWS_DEFAULT;
  const limit = finiteOrNull(input.limit);
  if (limit === null || limit <= 0) return { cols, rows, cells: [] };

  const total = Math.max(0, finiteOrNull(input.total) ?? 0);
  const cellCount = cols * rows;
  const tokensPerCell = limit / cellCount;

  const ranges: { key: RowKey; start: number; end: number }[] = [];
  let acc = 0;
  for (const key of CATEGORY_ORDER) {
    const value = rowTokens(input.rows, key);
    ranges.push({ key, start: acc, end: acc + value });
    acc += value;
  }

  const cells: GridCell[] = [];
  for (let i = 0; i < cellCount; i++) {
    const position = i * tokensPerCell;
    if (total <= 0 || position >= total) {
      cells.push({ rowKey: null, fill: 0 });
      continue;
    }
    const key = categoryAt(ranges, position) ?? CATEGORY_ORDER[CATEGORY_ORDER.length - 1];
    cells.push({ rowKey: key, fill: Math.min(1, Math.max(0, (total - position) / tokensPerCell)) });
  }

  return { cols, rows, cells };
}
