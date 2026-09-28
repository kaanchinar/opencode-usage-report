import { describe, it, expect } from "vitest";
import { buildGrid } from "@/context/grid";
import type { ContextRow, RowKey } from "@/context/types";

function row(key: RowKey, tokens: number | null): ContextRow {
  return { key, label: key, tokens, percent: null, exact: false };
}

describe("buildGrid", () => {
  it("produces cols * rows cells", () => {
    const grid = buildGrid({ rows: [], limit: 120, total: 0, cols: 20, gridRows: 6 });
    expect(grid.cols).toBe(20);
    expect(grid.rows).toBe(6);
    expect(grid.cells).toHaveLength(120);
  });

  it("defaults to 6 grid rows", () => {
    const grid = buildGrid({ rows: [], limit: 120, total: 0, cols: 10 });
    expect(grid.rows).toBe(6);
    expect(grid.cells).toHaveLength(60);
  });

  it("clamps cols at both ends", () => {
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: 3 }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: 0 }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: -5 }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: Number.NaN }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0 }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: 8 }).cols).toBe(8);
    expect(buildGrid({ rows: [], limit: 10, total: 0, cols: 100 }).cols).toBe(60);
  });

  it("returns empty cells when the limit is unknown or zero", () => {
    expect(buildGrid({ rows: [row("user", 5)], limit: null, total: 5, cols: 10 }).cells).toEqual([]);
    expect(buildGrid({ rows: [row("user", 5)], limit: 0, total: 5, cols: 10 }).cells).toEqual([]);
    expect(buildGrid({ rows: [row("user", 5)], limit: -1, total: 5, cols: 10 }).cells).toEqual([]);
  });

  it("renders a hollow grid when total is unknown", () => {
    const grid = buildGrid({ rows: [row("user", 5)], limit: 100, total: null, cols: 10, gridRows: 1 });
    expect(grid.cells).toHaveLength(10);
    expect(grid.cells.every((cell) => cell.rowKey === null && cell.fill === 0)).toBe(true);
  });

  it("fills left-to-right in category order", () => {
    const rows = [row("user", 15), row("agent", 5), row("reasoning", 80)];
    const grid = buildGrid({ rows, limit: 100, total: 100, cols: 10, gridRows: 1 });
    expect(grid.cells[0].rowKey).toBe("user");
    expect(grid.cells[1].rowKey).toBe("user");
    expect(grid.cells[2].rowKey).toBe("reasoning");
    expect(grid.cells[9].rowKey).toBe("reasoning");
    expect(grid.cells.every((cell) => cell.fill === 1)).toBe(true);
  });

  it("leaves a single partial cell at the total boundary", () => {
    const rows = [row("user", 15), row("agent", 5), row("reasoning", 80)];
    const grid = buildGrid({ rows, limit: 100, total: 75, cols: 10, gridRows: 1 });
    expect(grid.cells[7].fill).toBeCloseTo(0.5);
    expect(grid.cells[7].rowKey).toBe("reasoning");
    expect(grid.cells[8].fill).toBe(0);
    expect(grid.cells[8].rowKey).toBeNull();
    const partials = grid.cells.filter((cell) => cell.fill > 0 && cell.fill < 1);
    expect(partials).toHaveLength(1);
  });

  it("keeps every fill within 0..1", () => {
    const rows = [row("user", 400), row("agent", 300), row("tools", 500)];
    const over = buildGrid({ rows, limit: 100, total: 1200, cols: 10, gridRows: 1 });
    expect(over.cells.every((cell) => cell.fill >= 0 && cell.fill <= 1)).toBe(true);
    const under = buildGrid({ rows, limit: 1000, total: 120, cols: 10, gridRows: 1 });
    expect(under.cells.every((cell) => cell.fill >= 0 && cell.fill <= 1)).toBe(true);
  });

  it("never lets cumulative fill exceed total even with inflated rows", () => {
    const rows = [row("user", 500), row("agent", 500)];
    const total = 50;
    const limit = 100;
    const grid = buildGrid({ rows, limit, total, cols: 10, gridRows: 1 });
    const cumulative = grid.cells.reduce((sum, cell) => sum + cell.fill, 0) * (limit / 10);
    expect(cumulative).toBeLessThanOrEqual(total);
  });
});
