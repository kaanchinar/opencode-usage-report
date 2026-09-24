import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, ensureSessionId } from "@/cache";
import type { AdapterResult } from "@/types";

const env = (dir: string) => ({ OPENCODE_DATA_HOME: dir }) as unknown as NodeJS.ProcessEnv;
const result: AdapterResult = {
  windows: [
    {
      kind: "5h",
      label: "5-hour",
      usedPercent: 10,
      used: null,
      limit: null,
      remaining: null,
      resetsAt: null,
      status: "ok",
    },
  ],
};

describe("cache", () => {
  it("round-trips fresh entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    await writeCache("p1", result, env(dir));
    const r = await readCache("p1", 120, env(dir));
    expect(r?.fresh).toBe(true);
    expect(r?.entry.result.windows[0].usedPercent).toBe(10);
  });
  it("marks stale past TTL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    await writeCache("p1", result, env(dir));
    const r = await readCache("p1", -1, env(dir));
    expect(r?.fresh).toBe(false);
  });
  it("returns null on corrupt cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const stateDir = join(dir, "usage-report");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "cache-p1.json"), "{corrupt");
    expect(await readCache("p1", 120, env(dir))).toBeNull();
  });
  it("ensureSessionId persists one uuid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-"));
    const a = await ensureSessionId(env(dir));
    const b = await ensureSessionId(env(dir));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
