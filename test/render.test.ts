import { describe, it, expect } from "vitest";
import { renderText, renderJson } from "../src/render.js";
import type { ProviderReport } from "../src/types.js";

const base: ProviderReport = {
  provider: "kimi-code-plan-global", displayName: "Kimi Code (kimi.ai)", fetchedAt: new Date(Date.now() - 5 * 60000).toISOString(),
  source: "api", stale: false,
  windows: [{ kind: "5h", label: "5-hour", usedPercent: 42, used: 1218, limit: 2900, remaining: 1682, resetsAt: "2026-09-16T14:05:00Z", status: "ok" }],
  extras: { "Booster wallet": "3.21" }, error: null,
};

describe("renderText", () => {
  it("renders windows, extras, and percent", () => {
    const out = renderText([base]);
    expect(out).toContain("Kimi Code");
    expect(out).toContain("42%");
    expect(out).not.toContain("% used");
    expect(out).toContain("1,218 / 2,900");
    expect(out).toContain("Booster wallet: 3.21");
  });
  it("marks stale and local estimates", () => {
    const out = renderText([{ ...base, stale: true, source: "cache" }]);
    expect(out).toMatch(/stale/i);

    // Matches what fallback.ts actually produces: absolutes known, percent null.
    const est = renderText([
      {
        ...base,
        source: "local-estimate",
        windows: [{ ...base.windows[0], usedPercent: null, used: 350, limit: null, remaining: null }],
      },
    ]);
    expect(est).toContain("~");
    expect(est).toContain("~estimate");
    expect(est).not.toContain("—");
  });
  it("renders errors", () => {
    const out = renderText([{ ...base, source: "error", error: "no credential found", windows: [] }]);
    expect(out).toContain("⚠ Kimi Code (kimi.ai): no credential found");
  });
});
describe("renderJson", () => {
  it("emits parseable JSON", () => {
    expect(JSON.parse(renderJson([base]))[0].provider).toBe("kimi-code-plan-global");
  });
});
