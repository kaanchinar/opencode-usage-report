import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake secret in the exact shape adapters see. It is never a real credential.
const KEY = "sk-test-SECRET-key-123456";

// Registry + fallback are mocked so the test is fully offline and deterministic.
const h = vi.hoisted(() => {
  const fetchMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const localEstimateMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const adapters = [
    { id: "kimi-code-plan-global", displayName: "Kimi Code (kimi.ai)", fetch: fetchMock },
    { id: "opencode-go", displayName: "OpenCode Go", fetch: fetchMock },
  ];
  return { fetchMock, localEstimateMock, adapters };
});

vi.mock("@/providers/index", () => ({
  adapters: h.adapters,
  getAdapter: (id: string) => h.adapters.find((a) => a.id === id),
}));
vi.mock("@/fallback", () => ({ localEstimate: h.localEstimateMock }));

import { collectReports } from "@/report";
import { renderJson, renderText } from "@/render";
import { checkWarnings } from "@/warn";
import { AdapterError } from "@/types";
import type { AdapterResult, ProviderReport } from "@/types";

const dataEnv = (dir: string): NodeJS.ProcessEnv =>
  ({
    OPENCODE_DATA_HOME: dir,
    OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY: KEY,
    OPENCODE_USAGE_OPENCODE_GO_KEY: KEY,
  }) as unknown as NodeJS.ProcessEnv;

const successResult: AdapterResult = {
  windows: [
    {
      kind: "5h",
      label: "5-hour",
      usedPercent: 90,
      used: 900,
      limit: 1000,
      remaining: 100,
      resetsAt: null,
      status: "ok",
    },
  ],
  extras: { Plan: "Pro" },
};

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

describe("security: no key material anywhere (spec §7.7)", () => {
  beforeEach(() => {
    h.fetchMock.mockReset();
    h.localEstimateMock.mockReset();
  });

  it("never leaks an echoed key into reports, rendered output, cache, or warn state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "security-"));
    const env = dataEnv(dir);

    // 1. Sloppy upstream: the adapter error message embeds the raw key.
    h.fetchMock.mockRejectedValue(new AdapterError("auth", `upstream echoed ${KEY}`));
    h.localEstimateMock.mockResolvedValue(null);
    const errored = await collectReports({
      providers: ["kimi-code-plan-global"],
      options: { fallback: false },
      env,
    });
    expect(errored[0].source).toBe("error");
    expect(errored[0].error).toContain("<redacted>");
    expect(JSON.stringify(errored)).not.toContain(KEY);

    // 2. A successful provider writes a real cache file (holding the credential's key).
    h.fetchMock.mockReset();
    h.fetchMock.mockResolvedValue(successResult);
    const ok = await collectReports({ providers: ["opencode-go"], env });
    expect(ok[0].source).toBe("api");

    // 3. Render both reports and run warning detection (writes warn-state.json).
    const reports: ProviderReport[] = [...errored, ...ok];
    const rendered = `${renderText(reports)}\n${renderJson(reports)}`;
    expect(rendered).toContain("<redacted>");
    const hits = await checkWarnings(reports, 80, env);
    expect(hits).toHaveLength(1);

    // 4. Read back every artifact produced under the data home.
    const files = listFiles(join(dir, "usage-report"));
    expect(files.some((f) => f.endsWith("cache-opencode-go.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("warn-state.json"))).toBe(true);

    const diskArtifacts = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const everything = `${diskArtifacts}\n${rendered}`;
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain("sk-test");
  });
});
