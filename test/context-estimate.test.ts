import { describe, it, expect } from "vitest";
import { estimateJson, estimateTokens } from "@/context/estimate";

function containsNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some(containsNaN);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNaN);
  return false;
}

describe("estimateTokens", () => {
  it("rounds length/4", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("x".repeat(1000))).toBe(250);
  });

  it("returns 0 for non-string input", () => {
    expect(estimateTokens(123 as unknown as string)).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
    expect(estimateTokens({} as unknown as string)).toBe(0);
  });
});

describe("estimateJson", () => {
  it("estimates the serialized length", () => {
    expect(estimateJson({ a: 1 })).toBe(2); // '{"a":1}' -> 7 chars -> round(1.75)
    expect(estimateJson("test")).toBe(2); // '"test"' -> 6 chars -> round(1.5)
    expect(estimateJson(undefined)).toBe(0);
    expect(estimateJson(null)).toBe(1); // "null" -> 4 chars -> 1
  });

  it("never returns NaN", () => {
    expect(containsNaN(estimateJson(undefined))).toBe(false);
    expect(Number.isNaN(estimateTokens(null as unknown as string))).toBe(false);
  });
});
