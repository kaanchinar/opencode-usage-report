import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { kimiAdapter } from "../src/providers/kimi.js";
import { AdapterError } from "../src/types.js";

const cred = { type: "api" as const, key: "sk-test-key-123456" };
const opts = { timeoutMs: 1000 };
const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8"));
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })));
}
afterEach(() => vi.unstubAllGlobals());

describe("kimiAdapter", () => {
  it("parses canonical response preferring count-based windows", async () => {
    mockFetch(200, fixture("kimi-canonical.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    const fiveH = r.windows.find(w => w.kind === "5h")!;
    expect(fiveH.usedPercent).toBe(42);
    const weekly = r.windows.find(w => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBe(61);
    expect(r.extras?.["Plan"]).toBe("LEVEL_PRO");
    expect(r.extras?.["Booster wallet"]).toBe("3.21");
  });
  it("prefers authoritative counts over stale zeroed usages ratios (live regression)", async () => {
    mockFetch(200, fixture("kimi-stale-ratios.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    const fiveH = r.windows.find(w => w.kind === "5h")!;
    expect(fiveH.usedPercent).toBe(100);
    expect(fiveH.used).toBe(100);
    expect(fiveH.limit).toBe(100);
    expect(fiveH.resetsAt).toBe("2026-09-16T14:23:44.290Z");
    const weekly = r.windows.find(w => w.kind === "weekly")!;
    expect(weekly.usedPercent).toBe(33);
    expect(weekly.used).toBe(33);
    expect(weekly.resetsAt).toBe("2026-09-20T20:23:44.290Z");
  });
  it("falls back to usages ratios when no count-based data exists", async () => {
    mockFetch(200, {
      usages: {
        limit_5h: { used_ratio: 0.42, reset_time: "2026-09-16T14:05:00Z" },
        limit_7d: { used_ratio: 0.61, reset_time: "2026-09-22T00:00:00Z" },
      },
    });
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.windows.find(w => w.kind === "5h")?.usedPercent).toBe(42);
    expect(r.windows.find(w => w.kind === "weekly")?.usedPercent).toBe(61);
  });
  it("falls back to limits[] and top-level usage with string counts", async () => {
    mockFetch(200, fixture("kimi-strings.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    const fiveH = r.windows.find(w => w.kind === "5h")!;
    expect(fiveH.used).toBe(1218);
    expect(fiveH.usedPercent).toBe(42);
    expect(fiveH.resetsAt).toBe("2026-09-16T14:05:00.000Z");
  });
  it("handles minimal response", async () => {
    mockFetch(200, fixture("kimi-minimal.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].kind).toBe("weekly");
  });
  it("marks monthly frozen when totalQuota.used > 0", async () => {
    const body = { ...fixture("kimi-minimal.json"), totalQuota: { limit: "10", used: "3", remaining: "7" } };
    mockFetch(200, body);
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.windows.find(w => w.kind === "monthly")?.status).toBe("frozen");
  });
  it("sends Authorization and User-Agent headers", async () => {
    mockFetch(200, fixture("kimi-minimal.json"));
    await kimiAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer sk-test-key-123456");
    expect(headers["User-Agent"]).toMatch(/^opencode-usage-report\//);
  });
  it("maps 401 to auth error without leaking key", async () => {
    mockFetch(401, { error: { message: "invalid token sk-test-key-123456" } });
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toThrow(/<redacted>|invalid Kimi API key/);
  });
  it("throws network AdapterError after retry on 500", async () => {
    mockFetch(500, "oops");
    await expect(kimiAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "network" });
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
  });
  it("omits object booster balance and formats monthlyUsed price", async () => {
    mockFetch(200, fixture("kimi-booster-object.json"));
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.extras?.["Booster wallet"]).toBeUndefined();
    expect(r.extras?.["Booster used this month"]).toBe("$1.23 USD");
    expect(JSON.stringify(r.extras)).not.toContain("[object Object]");
  });
  it("formats numeric monthlyUsed and accepts numeric balance", async () => {
    const body = {
      ...fixture("kimi-minimal.json"),
      booster_wallet: { balance: 12.5, monthlyUsed: { currency: "USD", priceInCents: 5000 } },
    };
    mockFetch(200, body);
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.extras?.["Booster wallet"]).toBe("12.5");
    expect(r.extras?.["Booster used this month"]).toBe("$50.00 USD");
    expect(JSON.stringify(r.extras)).not.toContain("NaN");
  });
  it("ignores partial monthlyUsed without throwing or leaking objects", async () => {
    const body = {
      ...fixture("kimi-minimal.json"),
      booster_wallet: { monthlyUsed: { currency: "USD" } },
    };
    mockFetch(200, body);
    const r = await kimiAdapter.fetch(cred, opts);
    expect(r.extras?.["Booster used this month"]).toBeUndefined();
    expect(JSON.stringify(r.extras)).not.toContain("[object Object]");
  });
  it("accepts the resetsAt alias in usages ratios, limits[] details and totalQuota", async () => {
    mockFetch(200, {
      usages: { limit_5h: { used_ratio: 0.42, resetsAt: "2026-09-16T14:05:00Z" } },
      usage: { limit: "100", used: "1", remaining: "99", resetsAt: "2026-09-22T00:00:00Z" },
    });
    const ratio = await kimiAdapter.fetch(cred, opts);
    expect(ratio.windows.find(w => w.kind === "5h")?.resetsAt).toBe("2026-09-16T14:05:00.000Z");
    expect(ratio.windows.find(w => w.kind === "weekly")?.resetsAt).toBe("2026-09-22T00:00:00.000Z");

    mockFetch(200, {
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", used: "5", remaining: "95", resetsAt: "2026-09-16T15:05:00Z" },
        },
      ],
      usage: { limit: "100", used: "1", resetsAt: "2026-09-22T00:00:00Z" },
    });
    const detail = await kimiAdapter.fetch(cred, opts);
    expect(detail.windows.find(w => w.kind === "5h")?.resetsAt).toBe("2026-09-16T15:05:00.000Z");

    mockFetch(200, {
      usage: { limit: "100", used: "1", resetsAt: "2026-09-22T00:00:00Z" },
      totalQuota: { limit: "10", used: "3", remaining: "7", resetsAt: "2026-10-01T00:00:00Z" },
    });
    const quota = await kimiAdapter.fetch(cred, opts);
    expect(quota.windows.find(w => w.kind === "monthly")?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });
});
