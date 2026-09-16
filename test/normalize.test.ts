import { describe, it, expect } from "vitest";
import { toNumber, toISODate, pick, ratioToPercent, windowFromCounts } from "../src/normalize.js";

describe("toNumber", () => {
  it("parses numbers and numeric strings", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber("2900")).toBe(2900);
    expect(toNumber("nope")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
  });
});
describe("toISODate", () => {
  it("accepts ISO strings and epoch numbers", () => {
    expect(toISODate("2026-09-16T14:05:00Z")).toBe("2026-09-16T14:05:00.000Z");
    expect(toISODate("not a date")).toBeNull();
    expect(toISODate(null)).toBeNull();
  });
});
describe("pick", () => {
  it("returns first defined key", () => {
    expect(pick({ a: null, b: 2, c: 3 }, "a", "b", "c")).toBe(2);
    expect(pick({ x: 1 }, "a", "b")).toBeUndefined();
    expect(pick("nope", "a")).toBeUndefined();
  });
});
describe("ratioToPercent", () => {
  it("converts and clamps", () => {
    expect(ratioToPercent(0.421)).toBe(42.1);
    expect(ratioToPercent(1.5)).toBe(100);
    expect(ratioToPercent(-0.2)).toBe(0);
  });
});
describe("windowFromCounts", () => {
  it("computes percent from string counts", () => {
    const w = windowFromCounts("5h", "5-hour", { limit: "2900", used: "1218", remaining: "1682", reset: "2026-09-16T14:05:00Z" });
    expect(w.used).toBe(1218);
    expect(w.usedPercent).toBe(42);
    expect(w.resetsAt).toBe("2026-09-16T14:05:00.000Z");
    expect(w.status).toBe("ok");
  });
  it("leaves percent null when limit unknown", () => {
    const w = windowFromCounts("weekly", "Weekly", { used: 10 });
    expect(w.usedPercent).toBeNull();
  });
});
