import { describe, it, expect } from "vitest";
import { computeHeadroom } from "@/context/headroom";

describe("computeHeadroom", () => {
  it("uses limit.input when present", () => {
    const result = computeHeadroom({
      limit: { context: 200000, input: 180000, output: 20000 },
      total: 100000,
    });
    // reserved = min(20000, 20000) = 20000; usable = 180000 - 20000
    expect(result.usable).toBe(160000);
    expect(result.free).toBe(60000);
    expect(result.band).toBe("ok");
  });

  it("falls back to context - output when limit.input is absent", () => {
    const result = computeHeadroom({
      limit: { context: 200000, output: 20000 },
      total: 100000,
    });
    expect(result.usable).toBe(180000);
    expect(result.free).toBe(80000);
    expect(result.band).toBe("ok");
  });

  it("lets compaction.reserved override the default", () => {
    const result = computeHeadroom({
      limit: { context: 200000, input: 180000, output: 20000 },
      total: 100000,
      compaction: { reserved: 5000 },
    });
    expect(result.usable).toBe(175000);
    expect(result.free).toBe(75000);
  });

  it("falls back to the default for non-finite or negative reserved", () => {
    const limit = { context: 200000, input: 180000, output: 20000 };
    expect(computeHeadroom({ limit, total: 0, compaction: { reserved: -5 } }).usable).toBe(160000);
    expect(computeHeadroom({ limit, total: 0, compaction: { reserved: Number.NaN } }).usable).toBe(
      160000,
    );
    expect(
      computeHeadroom({ limit, total: 0, compaction: { reserved: Number.POSITIVE_INFINITY } })
        .usable,
    ).toBe(160000);
  });

  it("bands at exactly 5% and 15%", () => {
    // usable = 200 - 100 = 100
    const limit = { context: 200, input: 200, output: 100 };
    expect(computeHeadroom({ limit, total: 95 }).free).toBe(5);
    expect(computeHeadroom({ limit, total: 95 }).band).toBe("error");
    expect(computeHeadroom({ limit, total: 85 }).free).toBe(15);
    expect(computeHeadroom({ limit, total: 85 }).band).toBe("warning");
    expect(computeHeadroom({ limit, total: 84 }).band).toBe("ok");
    expect(computeHeadroom({ limit, total: 94 }).band).toBe("warning");
  });

  it("clamps usable at 0", () => {
    const result = computeHeadroom({
      limit: { context: 1000, input: 50, output: 100 },
      total: 0,
    });
    expect(result.usable).toBe(0);
    expect(result.free).toBe(0);
    expect(result.band).toBe("error");
  });

  it("returns nulls when the limit is unknown or non-finite", () => {
    expect(computeHeadroom({ limit: null, total: 100 })).toEqual({
      usable: null,
      free: null,
      band: "ok",
    });
    expect(
      computeHeadroom({ limit: { context: Number.NaN, output: 100 } as never, total: 100 }),
    ).toEqual({ usable: null, free: null, band: "ok" });
    expect(
      computeHeadroom({ limit: { context: 1000, output: Number.POSITIVE_INFINITY } as never, total: 1 }),
    ).toEqual({ usable: null, free: null, band: "ok" });
  });

  it("returns usable but null free when the total is unknown", () => {
    const result = computeHeadroom({
      limit: { context: 200000, input: 180000, output: 20000 },
      total: null,
    });
    expect(result.usable).toBe(160000);
    expect(result.free).toBeNull();
    expect(result.band).toBe("ok");
  });
});
