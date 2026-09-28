import { describe, it, expect } from "vitest";
import {
  alignLabel,
  buildLines,
  clip,
  EXTRAS_MAX_LENGTH,
  NAMED_WIDTH,
  windowRank,
} from "@/quota-lines";
import type { ProviderReport, UsageWindow, WindowKind } from "@/types";

type Theme = Parameters<typeof buildLines>[0];

function theme(): Theme {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => String(key),
  }) as unknown as Theme;
}

function report(overrides: Partial<ProviderReport> = {}): ProviderReport {
  return {
    provider: "p",
    displayName: "Provider",
    fetchedAt: "2026-09-16T12:00:00Z",
    source: "api",
    stale: false,
    windows: [],
    extras: {},
    error: null,
    ...overrides,
  };
}

function usageWindow(kind: WindowKind, overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    kind,
    label: kind,
    usedPercent: 50,
    used: null,
    limit: null,
    remaining: null,
    resetsAt: null,
    status: "ok",
    ...overrides,
  };
}

function lineText(line: { segments: { text: string }[] }): string {
  return line.segments.map((segment) => segment.text).join("");
}

const now = new Date("2026-09-16T12:00:00Z");

describe("clip / alignLabel", () => {
  it("collapses whitespace and trims", () => {
    expect(clip("  hello   world  ")).toBe("hello world");
    expect(clip("short", 60)).toBe("short");
  });

  it("truncates with an ellipsis at the requested width", () => {
    expect(clip("a".repeat(100))).toHaveLength(60);
    expect(clip("a".repeat(100)).endsWith("…")).toBe(true);
    expect(clip("a".repeat(100), 10)).toBe("a".repeat(9) + "…");
  });

  it("pads and truncates labels to NAMED_WIDTH", () => {
    expect(alignLabel("5h limit")).toHaveLength(NAMED_WIDTH);
    expect(alignLabel("a".repeat(20))).toHaveLength(NAMED_WIDTH);
    expect(alignLabel("a".repeat(20)).endsWith(" ")).toBe(true);
  });
});

describe("windowRank", () => {
  it("orders known kinds and puts unknowns last", () => {
    expect(windowRank("5h")).toBe(0);
    expect(windowRank("weekly")).toBe(1);
    expect(windowRank("monthly")).toBe(2);
    expect(windowRank("daily")).toBe(3);
    expect(windowRank("other")).toBe(4);
    expect(windowRank("mystery" as WindowKind)).toBe(4);
  });
});

describe("buildLines", () => {
  it("renders the api error row", () => {
    const lines = buildLines(theme(), [], false, "network unreachable", now, 14);
    expect(lineText(lines[0])).toBe("api error: network unreachable");
    expect(lines[0].segments[0].fg).toBe("error");
  });

  it("renders an error report's detail row", () => {
    const lines = buildLines(
      theme(),
      [report({ source: "error", error: "quota exploded" })],
      false,
      null,
      now,
      14,
    );
    expect(lineText(lines[0])).toBe("Provider");
    expect(lineText(lines[1])).toBe("quota exploded");
  });

  it("shows the (stale) and (est) markers", () => {
    const lines = buildLines(
      theme(),
      [report({ stale: true, source: "local-estimate" })],
      false,
      null,
      now,
      14,
    );
    expect(lineText(lines[0])).toBe("Provider (stale) (est)");
  });

  it("shows a loading row while busy with no reports", () => {
    const lines = buildLines(theme(), [], true, null, now, 14);
    expect(lineText(lines[0])).toBe("loading…");
  });

  it("orders windows by WINDOW_ORDER with unknown kinds last", () => {
    const lines = buildLines(
      theme(),
      [
        report({
          windows: [
            usageWindow("other", { label: "Other" }),
            usageWindow("monthly"),
            usageWindow("5h"),
            usageWindow("daily"),
            usageWindow("weekly"),
          ],
        }),
      ],
      false,
      null,
      now,
      14,
    );
    const labels = lines.slice(1).map((line) => line.segments[0].text.trim());
    expect(labels).toEqual(["5h limit", "Weekly limit", "Monthly limit", "Daily limit", "Other"]);

    const unknown = buildLines(
      theme(),
      [
        report({
          windows: [usageWindow("mystery" as WindowKind, { label: "Mystery" }), usageWindow("5h")],
        }),
      ],
      false,
      null,
      now,
      14,
    );
    const unknownLabels = unknown.slice(1).map((line) => line.segments[0].text.trim());
    expect(unknownLabels).toEqual(["5h limit", "Mystery"]);
  });

  it("renders the reset countdown column", () => {
    const lines = buildLines(
      theme(),
      [
        report({
          windows: [usageWindow("5h", { resetsAt: "2026-09-16T15:33:00Z" })],
        }),
      ],
      false,
      null,
      now,
      14,
    );
    expect(lineText(lines[1])).toContain("resets in 3h 33m");
    expect(lineText(lines[1])).toContain("█");
  });

  it("clips extras to EXTRAS_MAX_LENGTH", () => {
    const lines = buildLines(
      theme(),
      [report({ extras: { note: "x".repeat(200) } })],
      false,
      null,
      now,
      14,
    );
    expect(lines[1].segments[0].text).toHaveLength(EXTRAS_MAX_LENGTH);
  });
});
