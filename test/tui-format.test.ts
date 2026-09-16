import { describe, it, expect } from "vitest";
import {
  bar,
  coerceTuiOptions,
  countdown,
  formatAge,
  percentText,
  toneFor,
  windowLabel,
} from "../src/tui-format.js";

describe("bar", () => {
  it("renders empty, partial, and full bars", () => {
    expect(bar(0)).toBe("░".repeat(14));
    expect(bar(100)).toBe("█".repeat(14));
    expect(bar(null)).toBe("░".repeat(14));
  });

  it("rounds the filled width for 33%", () => {
    // round(0.33 * 14) === round(4.62) === 5
    expect(bar(33)).toBe("█".repeat(5) + "░".repeat(9));
  });

  it("clamps width to a minimum of 4", () => {
    expect(bar(50, 1)).toBe("██░░");
    expect(bar(50, 0)).toBe("██░░");
  });

  it("clamps width to a maximum of 40 and never throws", () => {
    expect(() => bar(50, 1e6)).not.toThrow();
    expect(bar(50, 1e6).length).toBeLessThanOrEqual(40);
    expect(bar(50, 1e6).length).toBe(40);
    expect(bar(50, 1e6)).toBe("█".repeat(20) + "░".repeat(20));
    expect(bar(50, -5).length).toBeGreaterThanOrEqual(4);
    expect(bar(50, Number.POSITIVE_INFINITY).length).toBeLessThanOrEqual(40);
  });

  it("honours larger widths", () => {
    expect(bar(50, 20)).toBe("█".repeat(10) + "░".repeat(10));
  });

  it("clamps out-of-range percentages", () => {
    expect(bar(150)).toBe("█".repeat(14));
    expect(bar(-10)).toBe("░".repeat(14));
  });

  it("treats non-finite percentages as empty", () => {
    expect(bar(Number.NaN)).toBe("░".repeat(14));
    expect(bar(Number.POSITIVE_INFINITY)).toBe("░".repeat(14));
  });
});

describe("toneFor", () => {
  it("maps thresholds (49/50/79/80)", () => {
    expect(toneFor(49, "ok")).toBe("success");
    expect(toneFor(50, "ok")).toBe("warning");
    expect(toneFor(79, "ok")).toBe("warning");
    expect(toneFor(80, "ok")).toBe("error");
  });

  it("maps every status", () => {
    expect(toneFor(10, "ok")).toBe("success");
    expect(toneFor(10, "unknown")).toBe("success");
    expect(toneFor(10, "rate-limited")).toBe("error");
    expect(toneFor(10, "frozen")).toBe("error");
    expect(toneFor(null, "ok")).toBe("textMuted");
    expect(toneFor(null, "unknown")).toBe("textMuted");
  });

  it("prioritises rate-limited/frozen over a null percent", () => {
    expect(toneFor(null, "rate-limited")).toBe("error");
    expect(toneFor(null, "frozen")).toBe("error");
  });
});

describe("countdown", () => {
  const now = new Date("2026-09-16T12:00:00Z");

  it("returns null for missing or invalid input", () => {
    expect(countdown(null, now)).toBeNull();
    expect(countdown("not-a-date", now)).toBeNull();
    expect(countdown("", now)).toBeNull();
  });

  it("returns now for under a minute and for past times", () => {
    expect(countdown("2026-09-16T12:00:30Z", now)).toBe("now");
    expect(countdown("2026-09-16T11:59:00Z", now)).toBe("now");
  });

  it("renders minutes only", () => {
    expect(countdown("2026-09-16T12:12:00Z", now)).toBe("12m");
  });

  it("renders hours and minutes", () => {
    expect(countdown("2026-09-16T15:33:00Z", now)).toBe("3h 33m");
  });

  it("renders days, hours, and minutes", () => {
    expect(countdown("2026-09-20T21:33:00Z", now)).toBe("4d 9h 33m");
  });

  it("drops zero units", () => {
    expect(countdown("2026-09-17T12:00:00Z", now)).toBe("1d");
    expect(countdown("2026-09-16T13:00:00Z", now)).toBe("1h");
  });
});

describe("windowLabel", () => {
  it("labels every known kind", () => {
    expect(windowLabel("5h", "fallback")).toBe("5h limit");
    expect(windowLabel("daily", "fallback")).toBe("Daily limit");
    expect(windowLabel("weekly", "fallback")).toBe("Weekly limit");
    expect(windowLabel("monthly", "fallback")).toBe("Monthly limit");
  });

  it("falls back for other kinds", () => {
    expect(windowLabel("other", "Custom window")).toBe("Custom window");
  });
});

describe("percentText", () => {
  it("prefers a rounded percentage", () => {
    expect(percentText({ usedPercent: 42.6, used: 1, limit: 2 })).toBe("43%");
  });

  it("falls back to used/limit", () => {
    expect(percentText({ usedPercent: null, used: 1218, limit: 2900 })).toBe(
      "1,218/2,900",
    );
  });

  it("falls back to a lone used count", () => {
    expect(percentText({ usedPercent: null, used: 350, limit: null })).toBe("~350");
  });

  it("renders a dash when nothing is known", () => {
    expect(percentText({ usedPercent: null, used: null, limit: null })).toBe("—");
  });

  it("never throws on undefined fields and falls through to a dash", () => {
    // Cast through `any`: these shapes intentionally violate the declared types.
    const undefinedPercent = percentText({
      usedPercent: undefined,
      used: null,
      limit: null,
    } as unknown as Parameters<typeof percentText>[0]);
    const undefinedUsed = percentText({
      usedPercent: null,
      used: undefined,
      limit: null,
    } as unknown as Parameters<typeof percentText>[0]);
    const undefinedLimit = percentText({
      usedPercent: null,
      used: null,
      limit: undefined,
    } as unknown as Parameters<typeof percentText>[0]);

    expect(undefinedPercent).toBe("—");
    expect(undefinedUsed).toBe("—");
    expect(undefinedLimit).toBe("—");
    expect(() =>
      percentText({ used: undefined, limit: undefined } as unknown as Parameters<typeof percentText>[0]),
    ).not.toThrow();
  });
});

describe("coerceTuiOptions", () => {
  it("returns the expected defaults for undefined and {}", () => {
    expect(coerceTuiOptions(undefined)).toEqual({
      cacheTtlSeconds: 120,
      thresholdPercent: 80,
      refreshIntervalSeconds: 60,
      barWidth: 14,
    });

    const opts = coerceTuiOptions({});
    expect(opts.cacheTtlSeconds).toBe(120);
    expect(opts.thresholdPercent).toBe(80);
    expect(opts.refreshIntervalSeconds).toBe(60);
    expect(opts.barWidth).toBe(14);
    expect(opts.providers).toBeUndefined();
  });

  it("floors and clamps barWidth to [4,40]", () => {
    expect(coerceTuiOptions({ barWidth: 1e6 }).barWidth).toBe(40);
    expect(coerceTuiOptions({ barWidth: 1 }).barWidth).toBe(4);
    expect(coerceTuiOptions({ barWidth: 0 }).barWidth).toBe(4);
    expect(coerceTuiOptions({ barWidth: -5 }).barWidth).toBe(4);
    expect(coerceTuiOptions({ barWidth: 22.9 }).barWidth).toBe(22);
    expect(coerceTuiOptions({ barWidth: "18" }).barWidth).toBe(18);
  });

  it("rounds and clamps refreshIntervalSeconds to [5,3600]", () => {
    expect(coerceTuiOptions({ refreshIntervalSeconds: 0 }).refreshIntervalSeconds).toBe(5);
    expect(coerceTuiOptions({ refreshIntervalSeconds: 2 }).refreshIntervalSeconds).toBe(5);
    expect(coerceTuiOptions({ refreshIntervalSeconds: -100 }).refreshIntervalSeconds).toBe(5);
    expect(coerceTuiOptions({ refreshIntervalSeconds: 1e9 }).refreshIntervalSeconds).toBe(3600);
    expect(coerceTuiOptions({ refreshIntervalSeconds: 12.6 }).refreshIntervalSeconds).toBe(13);
    expect(coerceTuiOptions({ refreshIntervalSeconds: "30" }).refreshIntervalSeconds).toBe(30);
  });

  it("rejects junk values and keeps defaults", () => {
    const opts = coerceTuiOptions({
      barWidth: "wide",
      refreshIntervalSeconds: Number.NaN,
      cacheTtlSeconds: "nope",
      thresholdPercent: {},
    });
    expect(opts.barWidth).toBe(14);
    expect(opts.refreshIntervalSeconds).toBe(60);
    expect(opts.cacheTtlSeconds).toBe(120);
    expect(opts.thresholdPercent).toBe(80);
  });

  it("keeps valid cacheTtlSeconds and thresholdPercent", () => {
    const opts = coerceTuiOptions({ cacheTtlSeconds: 300, thresholdPercent: 75 });
    expect(opts.cacheTtlSeconds).toBe(300);
    expect(opts.thresholdPercent).toBe(75);
  });

  it("normalises providers", () => {
    expect(coerceTuiOptions({ providers: ["a", 2, "b", null] }).providers).toEqual([
      "a",
      "b",
    ]);
    expect(coerceTuiOptions({ providers: [] }).providers).toBeUndefined();
    expect(coerceTuiOptions({ providers: null }).providers).toBeUndefined();
  });
});

describe("formatAge", () => {
  const now = new Date("2026-09-16T12:00:00Z");

  it("returns null for missing or invalid input", () => {
    expect(formatAge(null, now)).toBeNull();
    expect(formatAge("nope", now)).toBeNull();
  });

  it("renders compact minutes, hours, and days", () => {
    expect(formatAge("2026-09-16T11:46:00Z", now)).toBe("14m");
    expect(formatAge("2026-09-16T10:00:00Z", now)).toBe("2h");
    expect(formatAge("2026-09-13T12:00:00Z", now)).toBe("3d");
  });

  it("floors sub-minute ages to seconds", () => {
    expect(formatAge("2026-09-16T11:59:45Z", now)).toBe("15s");
  });

  it("clamps future timestamps to zero", () => {
    expect(formatAge("2026-09-16T12:05:00Z", now)).toBe("0s");
  });
});
