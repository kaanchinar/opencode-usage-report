import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { localEstimate } from "../src/fallback.js";

const env = (dir: string) => ({ OPENCODE_DATA_HOME: dir }) as unknown as NodeJS.ProcessEnv;

const MESSAGE_SCHEMA = `CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);`;

function makeDb(
  dir: string,
  rows: Array<{ providerID: string; tokens?: Record<string, unknown>; at: number; data?: string }>,
): void {
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(MESSAGE_SCHEMA);
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  rows.forEach((r, i) => {
    const data =
      r.data ??
      JSON.stringify({
        role: "assistant",
        providerID: r.providerID,
        modelID: "m",
        ...(r.tokens ? { tokens: r.tokens } : {}),
      });
    insert.run(`m${i}`, "s1", r.at, r.at, data);
  });
  db.close();
}

describe("localEstimate", () => {
  it("returns token windows from a plausible message table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const now = Date.now();
    makeDb(dir, [
      { providerID: "kimi-code-plan-global", tokens: { total: 100 }, at: now - 60_000 },
      { providerID: "kimi-code-plan-global", tokens: { total: 250 }, at: now - 2 * 3600_000 },
      { providerID: "kimi-code-plan-global", tokens: { total: 400 }, at: now - 3 * 24 * 3600_000 },
    ]);
    const result = await localEstimate("kimi-code-plan-global", env(dir));
    expect(result).not.toBeNull();
    const five = result!.windows.find((w) => w.kind === "5h");
    const weekly = result!.windows.find((w) => w.kind === "weekly");
    expect(five?.used).toBe(350);
    expect(weekly?.used).toBe(750);
    expect(five?.usedPercent).toBeNull();
    expect(weekly?.status).toBe("ok");
    expect(weekly?.resetsAt).toBeNull();
  });

  it("returns null when the db file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    expect(await localEstimate("kimi-code-plan-global", env(dir))).toBeNull();
  });

  it("returns null when there is no message table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const db = new DatabaseSync(join(dir, "opencode.db"));
    db.exec("CREATE TABLE unrelated (id text);");
    db.close();
    expect(await localEstimate("kimi-code-plan-global", env(dir))).toBeNull();
  });

  it("returns null when no rows match the provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const now = Date.now();
    makeDb(dir, [{ providerID: "other", tokens: { total: 10 }, at: now - 1000 }]);
    expect(await localEstimate("kimi-code-plan-global", env(dir))).toBeNull();
  });

  it("falls back to message counts when tokens are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const now = Date.now();
    makeDb(dir, [{ providerID: "kimi-code-plan-global", at: now - 1000 }]);
    const result = await localEstimate("kimi-code-plan-global", env(dir));
    expect(result).not.toBeNull();
    expect(result!.windows.find((w) => w.kind === "5h")?.used).toBe(1);
  });

  it("ignores corrupt rows rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const now = Date.now();
    makeDb(dir, [
      { providerID: "kimi-code-plan-global", at: now - 1000, data: "{not json" },
      { providerID: "kimi-code-plan-global", tokens: { total: 7 }, at: now - 1000 },
    ]);
    const result = await localEstimate("kimi-code-plan-global", env(dir));
    expect(result?.windows.find((w) => w.kind === "5h")?.used).toBe(7);
  });
});
