import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWarnings } from "@/warn";
import type { ProviderReport } from "@/types";

const env = (d: string) => ({ OPENCODE_DATA_HOME: d }) as unknown as NodeJS.ProcessEnv;
const report = (
  pct: number,
  resetsAt: string | null = "2026-09-16T14:05:00Z",
): ProviderReport[] => [
  {
    provider: "p",
    displayName: "P",
    fetchedAt: "2026-09-16T12:00:00Z",
    source: "api",
    stale: false,
    windows: [
      {
        kind: "5h",
        label: "5-hour",
        usedPercent: pct,
        used: null,
        limit: null,
        remaining: null,
        resetsAt,
        status: "ok",
      },
    ],
    extras: {},
    error: null,
  },
];

describe("checkWarnings", () => {
  it("fires once per crossing until reset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    expect(await checkWarnings(report(85), 80, env(dir))).toHaveLength(1);
    expect(await checkWarnings(report(90), 80, env(dir))).toHaveLength(0); // same window, already fired
    expect(await checkWarnings(report(10), 80, env(dir))).toHaveLength(0); // below threshold
    expect(await checkWarnings(report(95, "2026-09-16T19:05:00Z"), 80, env(dir))).toHaveLength(1); // new reset -> refire
  });
  it("fires on rate-limited status regardless of percent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    const r = report(50);
    r[0].windows[0].status = "rate-limited";
    expect(await checkWarnings(r, 80, env(dir))).toHaveLength(1);
  });
  it("respects threshold", async () => {
    const dir = mkdtempSync(join(tmpdir(), "warn-"));
    expect(await checkWarnings(report(79), 80, env(dir))).toHaveLength(0);
  });
});
