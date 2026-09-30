import { describe, it, expect } from "vitest";
import { toNumber, toISODate, pick } from "@/normalize";

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
