import { describe, it, expect } from "vitest";
import { buildContextLines, formatMoney, formatTokens } from "@/context/format";
import type { ContextBreakdown, ContextRow, GridCell, RowKey } from "@/context/types";

const LABELS: Record<RowKey, string> = {
  user: "User messages",
  agent: "Agent responses",
  reasoning: "Reasoning",
  tools: "Tool calls",
  system: "System & tools",
  free: "Free space",
};

function row(key: RowKey, tokens: number | null, percent: number | null): ContextRow {
  return { key, label: LABELS[key], tokens, percent, exact: key === "free" };
}

function cell(rowKey: RowKey | null, fill: number): GridCell {
  return { rowKey, fill };
}

function baseBreakdown(overrides: Partial<ContextBreakdown> = {}): ContextBreakdown {
  return {
    ready: true,
    modelName: "Kimi K2 (High)",
    total: 42318,
    limit: 200000,
    cost: 0,
    rows: [
      row("user", 8204, 4),
      row("agent", 11650, 6),
      row("reasoning", 2140, 1),
      row("tools", 12180, 6),
      row("system", 8144, 4),
      row("free", 157682, 79),
    ],
    grid: {
      cols: 4,
      rows: 1,
      cells: [cell("user", 1), cell("agent", 0.25), cell("reasoning", 0.75), cell("tools", 0.05)],
    },
    headroom: { usable: 180000, free: 137682, band: "ok" },
    systemDerived: false,
    systemCaptured: null,
    prunedToolOutputs: 0,
    ...overrides,
  };
}

function emptyBreakdown(): ContextBreakdown {
  return baseBreakdown({
    ready: false,
    total: null,
    rows: (["user", "agent", "reasoning", "tools", "system", "free"] as RowKey[]).map((key) =>
      row(key, null, null),
    ),
    grid: { cols: 4, rows: 1, cells: [cell(null, 0), cell(null, 0), cell(null, 0), cell(null, 0)] },
    headroom: { usable: null, free: null, band: "ok" },
  });
}

function lineText(line: { segments: { text: string }[] }): string {
  return line.segments.map((segment) => segment.text).join("");
}

function concat(lines: ReturnType<typeof buildContextLines>): string {
  return lines.map(lineText).join("\n");
}

function isGridLine(line: { segments: { text: string }[] }): boolean {
  return line.segments.length > 0 && line.segments.every((s) => /^[░▒▓█]{2}$/.test(s.text));
}

function legendLabels(line: { segments: { text: string }[] }): [string, string] {
  return [line.segments[1].text.trim(), line.segments[7].text.trim()];
}

describe("formatTokens / formatMoney", () => {
  it("groups integers and coerces non-finite values", () => {
    expect(formatTokens(42318)).toBe("42,318");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("renders USD currency defensively", () => {
    expect(formatMoney(0.42)).toBe("$0.42");
    expect(formatMoney(1.5)).toBe("$1.50");
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });
});

describe("buildContextLines header", () => {
  it("renders the populated header", () => {
    const lines = buildContextLines(baseBreakdown());
    expect(lineText(lines[0])).toBe("Kimi K2 (High) · 42,318 / 200,000 tokens (21.2%)");
    expect(lines[0].segments[0]).toMatchObject({ text: "Kimi K2 (High)", fg: "text", bold: true });
  });

  it("falls back to the raw model label when modelName is null", () => {
    const lines = buildContextLines(baseBreakdown({ modelName: null }), { modelLabel: "p1/m1" });
    expect(lineText(lines[0])).toBe("p1/m1 · 42,318 / 200,000 tokens (21.2%)");
  });

  it("renders the literal empty state", () => {
    const lines = buildContextLines(emptyBreakdown());
    expect(lineText(lines[0])).toBe("Kimi K2 (High) · 0 (0.0%)");
    expect(lineText(lines[1])).toBe("awaiting first response");
  });

  it("omits the limit and percent when limit is null", () => {
    const lines = buildContextLines(
      baseBreakdown({
        limit: null,
        total: 50,
        rows: [
          row("user", 10, null),
          row("agent", 0, null),
          row("reasoning", 0, null),
          row("tools", 0, null),
          row("system", 40, null),
          row("free", null, null),
        ],
        grid: { cols: 4, rows: 0, cells: [] },
      }),
    );
    expect(lineText(lines[0])).toBe("Kimi K2 (High) · 50 tokens");
    expect(lines.some(isGridLine)).toBe(false);
    expect(concat(lines)).not.toContain("/ 200,000");
    expect(concat(lines)).not.toContain("tokens (");
  });
});

describe("buildContextLines grid", () => {
  it("emits one line per grid row, each cols * 2 characters wide", () => {
    const lines = buildContextLines(
      baseBreakdown({
        grid: { cols: 4, rows: 3, cells: Array.from({ length: 12 }, () => cell(null, 0)) },
      }),
    );
    const grid = lines.filter(isGridLine);
    expect(grid).toHaveLength(3);
    for (const line of grid) {
      expect(lineText(line)).toHaveLength(4 * 2);
    }
  });

  it("selects glyphs at fill boundaries", () => {
    const lines = buildContextLines(
      baseBreakdown({
        grid: {
          cols: 4,
          rows: 1,
          cells: [cell("user", 0), cell("agent", 0.25), cell("reasoning", 0.75), cell("tools", 1)],
        },
      }),
    );
    const [grid] = lines.filter(isGridLine);
    expect(lineText(grid)).toBe("░░▒▒▓▓██");
    expect(grid.segments.map((s) => s.fg)).toEqual([
      "info",
      "success",
      "secondary",
      "warning",
    ]);
  });

  it("colours free cells with borderSubtle", () => {
    const lines = buildContextLines(
      baseBreakdown({ grid: { cols: 1, rows: 1, cells: [cell(null, 0)] } }),
    );
    const [grid] = lines.filter(isGridLine);
    expect(grid.segments[0].fg).toBe("borderSubtle");
  });
});

describe("buildContextLines legend", () => {
  it("renders the six rows in fixed key order across two columns", () => {
    const lines = buildContextLines(baseBreakdown());
    const legend = lines.filter((line) => lineText(line).startsWith("●"));
    expect(legend).toHaveLength(3);
    expect(legendLabels(legend[0])).toEqual(["User messages", "Tool calls"]);
    expect(legendLabels(legend[1])).toEqual(["Agent responses", "System & tools"]);
    expect(legendLabels(legend[2])).toEqual(["Reasoning", "Free space"]);
    expect(lineText(legend[0])).toContain("8,204");
    expect(lineText(legend[0])).toContain("4.0%");
  });

  it("adds the derived marker only when systemDerived is true", () => {
    const normal = buildContextLines(baseBreakdown());
    expect(concat(normal)).not.toContain("(derived)");

    const derived = buildContextLines(baseBreakdown({ systemDerived: true }));
    const legend = derived.filter((line) => lineText(line).startsWith("●"));
    expect(lineText(legend[1])).toContain("System & tools (derived)");
  });
});

describe("buildContextLines sub-breakdown", () => {
  it("is absent without a capture and present with one", () => {
    expect(concat(buildContextLines(baseBreakdown()))).not.toContain("system prompt");
    const withCapture = buildContextLines(baseBreakdown({ systemCaptured: 6102 }));
    expect(concat(withCapture)).toContain("↳ 6,102 system prompt + 2,042 tools & framing");
  });

  it("clamps the framing remainder at zero", () => {
    const overshoot = buildContextLines(baseBreakdown({ systemCaptured: 9000 }));
    expect(concat(overshoot)).toContain("↳ 9,000 system prompt + 0 tools & framing");
  });
});

describe("buildContextLines headroom and pruned outputs", () => {
  it("omits the headroom line when usable is null", () => {
    const lines = buildContextLines(
      baseBreakdown({ headroom: { usable: null, free: null, band: "ok" } }),
    );
    expect(concat(lines)).not.toContain("Auto-compacts");
  });

  it("tones the headroom line by band", () => {
    const error = buildContextLines(
      baseBreakdown({ headroom: { usable: 100, free: 1, band: "error" } }),
    );
    const headroom = error.find((line) => lineText(line).startsWith("Auto-compacts"));
    expect(headroom?.segments[0].fg).toBe("error");
  });

  it("omits the cost segment when cost is zero and includes it otherwise", () => {
    expect(concat(buildContextLines(baseBreakdown()))).not.toContain("spent");
    const lines = buildContextLines(baseBreakdown({ cost: 0.42 }));
    const headroom = lines.find((line) => lineText(line).startsWith("Auto-compacts"));
    expect(headroom).toBeDefined();
    expect(lineText(headroom as { segments: { text: string }[] })).toBe(
      "Auto-compacts at 180,000 · 137,682 headroom · $0.42 spent",
    );
  });

  it("appends the pruned-outputs line only when non-zero", () => {
    expect(concat(buildContextLines(baseBreakdown()))).not.toContain("pruned from context");
    expect(concat(buildContextLines(baseBreakdown({ prunedToolOutputs: 2 })))).toContain(
      "2 tool outputs pruned from context",
    );
  });
});

describe("buildContextLines defensiveness", () => {
  it("never emits NaN or undefined", () => {
    const variants: ContextBreakdown[] = [
      baseBreakdown(),
      emptyBreakdown(),
      baseBreakdown({
        limit: null,
        total: null,
        headroom: { usable: null, free: null, band: "ok" },
      }),
      baseBreakdown({ systemCaptured: 0, systemDerived: true, cost: 0.42, prunedToolOutputs: 3 }),
    ];
    for (const breakdown of variants) {
      expect(concat(buildContextLines(breakdown))).not.toMatch(/NaN|undefined/);
    }
  });
});
