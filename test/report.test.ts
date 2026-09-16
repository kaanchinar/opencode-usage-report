import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Registry + fallback are mocked so no network/DB is touched. Both providers are
// present so the "known providers" list in the unknown-id error matches reality.
const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const localEstimateMock = vi.fn();
  const adapters = [
    { id: "kimi-for-coding", displayName: "Kimi Code", fetch: fetchMock },
    { id: "opencode-go", displayName: "OpenCode Go", fetch: fetchMock },
  ];
  return { fetchMock, localEstimateMock, adapters };
});

vi.mock("../src/providers/index.js", () => ({
  adapters: h.adapters,
  getAdapter: (id: string) => h.adapters.find((a) => a.id === id),
}));

vi.mock("../src/fallback.js", () => ({ localEstimate: h.localEstimateMock }));

import { collectReports, DEFAULT_OPTIONS } from "../src/report.js";
import { readCache, writeCache } from "../src/cache.js";
import { AdapterError } from "../src/types.js";
import type { AdapterResult } from "../src/types.js";

const KEY = "test-key-abcdef123456";

const env = (dir: string, extra: Record<string, string> = {}) =>
  ({ OPENCODE_DATA_HOME: dir, ...extra }) as unknown as NodeJS.ProcessEnv;
const credEnv = (dir: string) => env(dir, { OPENCODE_USAGE_KIMI_FOR_CODING_KEY: KEY });

const result: AdapterResult = {
  windows: [
    { kind: "5h", label: "5-hour", usedPercent: 12, used: null, limit: null, remaining: null, resetsAt: null, status: "ok" },
  ],
  extras: { Plan: "Pro" },
};

const freshDir = () => mkdtempSync(join(tmpdir(), "report-"));

describe("collectReports", () => {
  beforeEach(() => {
    h.fetchMock.mockReset();
    h.localEstimateMock.mockReset();
  });

  it("exposes sensible defaults", () => {
    expect(DEFAULT_OPTIONS).toEqual({
      thresholdPercent: 80,
      cacheTtlSeconds: 120,
      providers: null,
      fallback: true,
    });
  });

  it("returns an error row for an unknown provider id", async () => {
    const reports = await collectReports({ providers: ["nope"], env: env(freshDir()) });
    expect(reports).toHaveLength(1);
    expect(reports[0].provider).toBe("nope");
    expect(reports[0].source).toBe("error");
    expect(reports[0].error).toBe(
      "unknown provider 'nope' (known: kimi-for-coding, opencode-go)",
    );
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("returns a no-credential error row when nothing resolves", async () => {
    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      env: env(freshDir()), // empty data home, no env override
    });
    expect(reports[0].source).toBe("error");
    expect(reports[0].displayName).toBe("Kimi Code");
    expect(reports[0].error).toBe("no credential found");
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("serves a fresh cache entry without calling the adapter", async () => {
    const dir = freshDir();
    await writeCache("kimi-for-coding", result, env(dir));

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { cacheTtlSeconds: 120 },
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("cache");
    expect(reports[0].stale).toBe(false);
    expect(reports[0].error).toBeNull();
    expect(reports[0].windows[0].usedPercent).toBe(12);
    expect(reports[0].extras).toEqual({ Plan: "Pro" });
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("fetches, reports api, and writes the cache on success", async () => {
    const dir = freshDir();
    h.fetchMock.mockResolvedValue(result);

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("api");
    expect(reports[0].stale).toBe(false);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(await readCache("kimi-for-coding", 120, env(dir))).not.toBeNull();
  });

  it("bypasses a fresh cache when refresh is requested", async () => {
    const dir = freshDir();
    await writeCache("kimi-for-coding", result, env(dir));
    h.fetchMock.mockResolvedValue(result);

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      refresh: true,
      options: { cacheTtlSeconds: 120 },
      env: credEnv(dir),
    });

    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(reports[0].source).toBe("api");
  });

  it("falls back to the local estimate when the adapter throws", async () => {
    const dir = freshDir();
    h.fetchMock.mockRejectedValue(new AdapterError("network", "boom"));
    h.localEstimateMock.mockResolvedValue({
      windows: [
        { kind: "5h", label: "5-hour (local estimate)", usedPercent: null, used: 3, limit: null, remaining: null, resetsAt: null, status: "ok" },
      ],
      extras: { source: "opencode.db" },
    });

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { fallback: true },
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("local-estimate");
    expect(reports[0].stale).toBe(true);
    expect(reports[0].windows).toHaveLength(1);
    expect(reports[0].error).toContain("boom");
  });

  it("serves stale cache (stale: true) when the adapter throws and a cache exists", async () => {
    const dir = freshDir();
    await writeCache("kimi-for-coding", result, env(dir));
    h.fetchMock.mockRejectedValue(new AdapterError("network", "down"));

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { cacheTtlSeconds: -1 }, // force the fetch path
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("cache");
    expect(reports[0].stale).toBe(true);
    expect(reports[0].error).toContain("down");
    expect(h.localEstimateMock).not.toHaveBeenCalled();
  });

  it("returns an error row when the adapter throws and fallback is disabled", async () => {
    const dir = freshDir();
    h.fetchMock.mockRejectedValue(new AdapterError("network", "boom"));

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { fallback: false },
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("error");
    expect(reports[0].error).toContain("boom");
    expect(h.localEstimateMock).not.toHaveBeenCalled();
  });

  it("returns an error row when fallback is enabled but the local estimate is unavailable", async () => {
    const dir = freshDir();
    h.fetchMock.mockRejectedValue(new AdapterError("network", "boom"));
    h.localEstimateMock.mockResolvedValue(null);

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { fallback: true },
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("error");
    expect(reports[0].error).toContain("boom");
  });

  it("honors options.providers when no explicit provider filter is given", async () => {
    const dir = freshDir();
    h.fetchMock.mockResolvedValue(result);

    const reports = await collectReports({
      options: { providers: ["opencode-go"] },
      env: credEnv(dir), // no credential for opencode-go -> error row is still proof of selection
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].provider).toBe("opencode-go");
  });

  it("collects every registered provider by default", async () => {
    const dir = freshDir();
    h.fetchMock.mockResolvedValue(result);

    const reports = await collectReports({ env: credEnv(dir) });
    expect(reports.map((r) => r.provider)).toEqual(["kimi-for-coding", "opencode-go"]);
  });

  it("treats an empty provider filter as all providers", async () => {
    const dir = freshDir();
    h.fetchMock.mockResolvedValue(result);

    const viaArg = await collectReports({ providers: [], env: credEnv(dir) });
    expect(viaArg.map((r) => r.provider)).toEqual(["kimi-for-coding", "opencode-go"]);

    const viaOptions = await collectReports({ options: { providers: [] }, env: credEnv(dir) });
    expect(viaOptions.map((r) => r.provider)).toEqual(["kimi-for-coding", "opencode-go"]);
  });

  it("never leaks key material into error reports", async () => {
    const dir = freshDir();
    h.fetchMock.mockRejectedValue(new AdapterError("auth", `rejected key ${KEY}`));

    const reports = await collectReports({
      providers: ["kimi-for-coding"],
      options: { fallback: false },
      env: credEnv(dir),
    });

    expect(reports[0].source).toBe("error");
    expect(JSON.stringify(reports[0])).not.toContain(KEY);
  });
});
