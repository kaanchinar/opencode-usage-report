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

import definition from "@/index";
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
  return api.server({ client } as unknown as PluginInput, undefined);
}

// ---------------------------------------------------------------------------
// OpenCode 2 plugin definition (default export) and the subset of the V2
// context this plugin uses. The harness validates the default export against a
// `{ id, setup }` schema before setup runs (see err_b890e30e).
// ---------------------------------------------------------------------------

interface V2ToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (input: Record<string, unknown> | undefined) => Promise<{ content: string }>;
}

interface V2ContextEvent {
  sessionID?: string;
  model?: { providerID?: string; id?: string };
  system?: Array<{ type?: string; text?: string } | string>;
}

interface FakeV2Context {
  options: Record<string, unknown>;
  tool: {
    transform: (cb: (editor: { add: (tool: V2ToolDefinition) => void }) => void) => Promise<void>;
  };
  session: { hook: (name: string, cb: (event: V2ContextEvent) => unknown) => Promise<void> };
  event: { subscribe: (opts: { signal: AbortSignal }) => AsyncIterable<{ type: string }> };
  tui?: { showToast: (input: unknown) => Promise<unknown> };
}

type V2Setup = (ctx: FakeV2Context) => Promise<(() => void) | void>;

// The default export is a function under the old (V1-only) shape and an object
// under the new one; cast so the same tests compile against both and fail at
// runtime when the V2 fields are missing.
const api = definition as unknown as {
  id: string;
  setup: V2Setup;
  server: (input: PluginInput, options?: unknown) => Promise<Hooks>;
};

function makeV2Ctx(events: Array<{ type: string }> = []) {
  const tools: V2ToolDefinition[] = [];
  const hooks: Record<string, (event: V2ContextEvent) => unknown> = {};
  const signals: AbortSignal[] = [];
  const ctx: FakeV2Context = {
    options: {},
    tool: {
      transform: async (cb) => {
        cb({ add: (tool) => tools.push(tool) });
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks[name] = cb;
      },
    },
    event: {
      subscribe: (opts) => {
        signals.push(opts.signal);
        return (async function* () {
          for (const event of events) yield event;
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) return resolve();
            opts.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        })();
      },
    },
  };
  return { ctx, tools, hooks, signals };
}

describe("index plugin wiring (V1 server)", () => {
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

describe("index V2 plugin definition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.collectReports.mockReset();
    h.checkWarnings.mockReset();
    h.writeCapture.mockClear();
    h.writeCapture.mockResolvedValue(undefined);
  });

  afterEach(() => vi.useRealTimers());

  it("is a definition object with an id and setup (err_b890e30e regression)", () => {
    expect(api).toBeTypeOf("object");
    expect(api.id).toBe("opencode-usage-report");
    expect(api.setup).toBeTypeOf("function");
  });

  it("registers usage_report as a V2 tool and renders its result", async () => {
    h.collectReports.mockResolvedValue([report]);
    const { ctx, tools } = makeV2Ctx();

    await api.setup(ctx);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("usage_report");
    expect(tools[0].input).toMatchObject({ type: "object" });

    const result = await tools[0].execute({ provider: "kimi" });
    expect(result).toEqual({ content: expect.stringContaining("Kimi Code") });
    expect(h.collectReports).toHaveBeenCalledWith(expect.objectContaining({ providers: ["kimi"] }));
  });

  it("captures the joined system prompt through the V2 context hook", async () => {
    const { ctx, hooks } = makeV2Ctx();

    await api.setup(ctx);
    await hooks.context({
      sessionID: "ses_1",
      model: { providerID: "kimi", id: "k2" },
      system: [{ type: "text", text: "a".repeat(4000) }],
    });

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

  it("runs a throttled warning check at startup like V1 (spec §3.6)", async () => {
    h.collectReports.mockResolvedValue([report]);
    h.checkWarnings.mockResolvedValue([hit]);
    const showToast = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({});
    const { ctx } = makeV2Ctx();
    ctx.tui = { showToast };

    await api.setup(ctx);
    expect(h.collectReports).not.toHaveBeenCalled(); // fire-and-forget, not synchronous

    await vi.advanceTimersByTimeAsync(0);
    expect(h.collectReports).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledOnce();
  });

  it("subscribes to events and aborts the subscription on cleanup", async () => {
    const { ctx, signals } = makeV2Ctx();

    const cleanup = await api.setup(ctx);

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(cleanup).toBeTypeOf("function");

    cleanup!();
    expect(signals[0].aborted).toBe(true);
  });
});
