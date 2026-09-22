import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

// report/warn are mocked so plugin wiring can be exercised without network,
// disk state, or the 10-minute throttle depending on real collection.
const h = vi.hoisted(() => ({
  collectReports: vi.fn(),
  checkWarnings: vi.fn(),
}));

vi.mock("../src/report.js", () => ({
  collectReports: h.collectReports,
  DEFAULT_OPTIONS: { thresholdPercent: 80, cacheTtlSeconds: 120, providers: null, fallback: true },
}));
vi.mock("../src/warn.js", () => ({ checkWarnings: h.checkWarnings }));

import plugin from "../src/index.js";
import type { ProviderReport, UsageWindow } from "../src/types.js";

const window90: UsageWindow = {
  kind: "5h",
  label: "5-hour",
  usedPercent: 90,
  used: null,
  limit: null,
  remaining: null,
  resetsAt: null,
  status: "ok",
};

const report: ProviderReport = {
  provider: "kimi-code-plan-global",
  displayName: "Kimi Code (kimi.ai)",
  fetchedAt: "2026-09-16T12:00:00Z",
  source: "api",
  stale: false,
  windows: [window90],
  extras: {},
  error: null,
};

const hit = {
  provider: "kimi-code-plan-global",
  displayName: "Kimi Code (kimi.ai)",
  window: window90,
  message: "Kimi Code (kimi.ai) 5-hour window at 90%",
};

type EventArg = Parameters<NonNullable<Hooks["event"]>>[0];
type ConfigArg = Parameters<NonNullable<Hooks["config"]>>[0];

const idleEvent: EventArg = {
  event: { type: "session.idle", properties: { sessionID: "ses_mock" } },
};

function makeHooks(showToast = vi.fn().mockResolvedValue({})): Promise<Hooks> {
  const client = { tui: { showToast } } as unknown as PluginInput["client"];
  return plugin({ client } as unknown as PluginInput, undefined);
}

describe("index plugin wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.collectReports.mockReset();
    h.checkWarnings.mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("does not overwrite an existing usage command", async () => {
    const hooks = await makeHooks();
    const cfg = {
      command: { usage: { template: "custom $ARGUMENTS", description: "mine" } },
    } as unknown as ConfigArg;

    await hooks.config!(cfg);

    expect(cfg.command!.usage.template).toBe("custom $ARGUMENTS");
    expect(cfg.command!.usage.description).toBe("mine");
  });

  it("injects the usage command when the user has none", async () => {
    const hooks = await makeHooks();
    const cfg = {} as unknown as ConfigArg;

    await hooks.config!(cfg);

    expect(cfg.command!.usage.template).toContain("usage_report");
  });

  it("swallows showToast rejections on session.idle (headless mode)", async () => {
    h.collectReports.mockResolvedValue([report]);
    h.checkWarnings.mockResolvedValue([hit]);
    const showToast = vi.fn().mockRejectedValue(new Error("tui unavailable"));
    const hooks = await makeHooks(showToast);

    await expect(hooks.event!(idleEvent)).resolves.toBeUndefined();

    expect(showToast).toHaveBeenCalledOnce();
    expect(h.collectReports).toHaveBeenCalledOnce();
  });

  it("runs a single throttled warning check at startup (spec §3.6)", async () => {
    h.collectReports.mockResolvedValue([report]);
    h.checkWarnings.mockResolvedValue([hit]);
    const showToast = vi.fn().mockResolvedValue({});
    const hooks = await makeHooks(showToast);

    expect(h.collectReports).not.toHaveBeenCalled(); // fire-and-forget, not synchronous
    await vi.advanceTimersByTimeAsync(0);
    expect(h.collectReports).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledOnce();

    // The startup run consumed the same 10-minute throttle as the event hook.
    await hooks.event!(idleEvent);
    expect(h.collectReports).toHaveBeenCalledOnce();
  });
});
