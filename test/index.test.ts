import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

// report/warn are mocked so plugin wiring can be exercised without network,
// disk state, or the 10-minute throttle depending on real collection.
const h = vi.hoisted(() => ({
  collectReports: vi.fn<() => Promise<ProviderReport[]>>(),
  checkWarnings: vi.fn<() => Promise<WarnHit[]>>(),
  writeCapture: vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock("@/report", () => ({
  collectReports: h.collectReports,
  DEFAULT_OPTIONS: { thresholdPercent: 80, cacheTtlSeconds: 120, providers: null, fallback: true },
}));
vi.mock("@/warn", () => ({ checkWarnings: h.checkWarnings }));
vi.mock("@/context/system", () => ({ writeCapture: h.writeCapture }));

import plugin from "@/index";
import type { ProviderReport, UsageWindow } from "@/types";
import type { WarnHit } from "@/warn";

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

const idleEvent: EventArg = {
  event: { type: "session.idle", properties: { sessionID: "ses_mock" } },
};

function makeHooks(
  showToast = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
): Promise<Hooks> {
  const client = { tui: { showToast } } as unknown as PluginInput["client"];
  return plugin({ client } as unknown as PluginInput, undefined);
}

describe("index plugin wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.collectReports.mockReset();
    h.checkWarnings.mockReset();
    h.writeCapture.mockClear();
    h.writeCapture.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("captures the system prompt size on each chat request", async () => {
    const hooks = await makeHooks();
    const system = "a".repeat(4000);

    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_1", model: { id: "k2", providerID: "kimi" } } as never,
      { system: [system] } as never,
    );

    expect(h.writeCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        sessionID: "ses_1",
        providerID: "kimi",
        modelID: "k2",
        systemChars: 4000,
        systemTokens: 1000,
      }),
    );
  });

  it("ignores a system transform with no session id or empty system", async () => {
    const hooks = await makeHooks();

    await hooks["experimental.chat.system.transform"]!(
      { model: { id: "k2", providerID: "kimi" } } as never,
      { system: ["x"] } as never,
    );
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "ses_1", model: { id: "k2", providerID: "kimi" } } as never,
      { system: [] } as never,
    );

    expect(h.writeCapture).not.toHaveBeenCalled();
  });

  it("never throws out of the system transform hook", async () => {
    const hooks = await makeHooks();
    h.writeCapture.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      hooks["experimental.chat.system.transform"]!(
        { sessionID: "ses_1", model: { id: "k2", providerID: "kimi" } } as never,
        { system: ["hello"] } as never,
      ),
    ).resolves.toBeUndefined();
  });

  it("swallows showToast rejections on session.idle (headless mode)", async () => {
    h.collectReports.mockResolvedValue([report]);
    h.checkWarnings.mockResolvedValue([hit]);
    const showToast = vi
      .fn<(...args: unknown[]) => Promise<unknown>>()
      .mockRejectedValue(new Error("tui unavailable"));
    const hooks = await makeHooks(showToast);

    await expect(hooks.event!(idleEvent)).resolves.toBeUndefined();

    expect(showToast).toHaveBeenCalledOnce();
    expect(h.collectReports).toHaveBeenCalledOnce();
  });

  it("runs a single throttled warning check at startup (spec §3.6)", async () => {
    h.collectReports.mockResolvedValue([report]);
    h.checkWarnings.mockResolvedValue([hit]);
    const showToast = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
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
