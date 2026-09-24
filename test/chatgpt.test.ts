import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatgptAdapter, chatgptPlan } from "@/providers/chatgpt";
import { collectReports } from "@/report";

const cred = { type: "oauth" as const, key: "tok-chatgpt-123456", accountId: "acct-1" };
const opts = { timeoutMs: 1000 };
const fixture = (n: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    ),
  );
}
/** Builds a usage payload carrying the given credits block. */
function response(credits: Record<string, unknown>) {
  return {
    plan_type: "pro",
    rate_limit: {
      limit_reached: false,
      primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 1792740597 },
    },
    credits,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("chatgptAdapter", () => {
  it("parses the free fixture (single monthly window)", async () => {
    mockFetch(200, fixture("chatgpt-free.json"));
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].kind).toBe("monthly");
    expect(r.windows[0].usedPercent).toBe(12.5);
    expect(r.windows[0].resetsAt).toBe(new Date(1792740597 * 1000).toISOString());
    expect(r.extras?.["Plan"]).toBe("ChatGPT Free");
  });

  it("parses the plus fixture (5h + weekly windows)", async () => {
    mockFetch(200, fixture("chatgpt-plus.json"));
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(r.windows.map((w) => w.kind)).toEqual(["5h", "weekly"]);
    expect(r.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
    expect(r.extras?.["Plan"]).toBe("ChatGPT Plus");
  });

  it("rejects with auth before fetching when the account id is missing", async () => {
    const noAccount = { type: "oauth" as const, key: "tok-chatgpt-123456" };
    const fetchSpy = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(chatgptAdapter.fetch(noAccount, opts)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the ChatGPT-Account-Id header when present", async () => {
    mockFetch(200, fixture("chatgpt-free.json"));
    await chatgptAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(headers.Authorization).toBe("Bearer tok-chatgpt-123456");
  });

  it("marks windows rate-limited when limit_reached is true", async () => {
    mockFetch(200, {
      plan_type: "plus",
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1792740597 },
      },
      credits: {},
    });
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    expect(r.windows.every((w) => w.status === "rate-limited")).toBe(true);
  });

  it("marks windows rate-limited when allowed is false", async () => {
    mockFetch(200, {
      plan_type: "plus",
      rate_limit: {
        allowed: false,
        limit_reached: false,
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1792740597 },
      },
      credits: {},
    });
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(r.windows[0].status).toBe("rate-limited");
  });

  it("retries once on a 500 and succeeds on the second attempt", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture("chatgpt-free.json")), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.windows).toHaveLength(1);
  });

  it("maps a persistent 5xx to network after one retry", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps 429 to rate-limited without retrying", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "rate-limited" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps 86400-second windows to daily", async () => {
    mockFetch(200, {
      plan_type: "plus",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 5, limit_window_seconds: 86400, reset_at: 1792740597 },
      },
      credits: {},
    });
    const r = await chatgptAdapter.fetch(cred, opts);
    expect(r.windows[0].kind).toBe("daily");
    expect(r.windows[0].label).toBe("Daily");
  });

  it("throws bad-response when both usage windows are absent", async () => {
    mockFetch(200, {
      plan_type: "plus",
      rate_limit: { limit_reached: false, primary_window: null, secondary_window: null },
      credits: {},
    });
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("formats credits as unlimited, numeric, or available", async () => {
    mockFetch(200, response({ unlimited: true }));
    expect((await chatgptAdapter.fetch(cred, opts)).extras?.["Credits"]).toBe("unlimited");

    mockFetch(200, response({ has_credits: true, balance: "12.5" }));
    expect((await chatgptAdapter.fetch(cred, opts)).extras?.["Credits"]).toBe("$12.50");

    mockFetch(200, response({ has_credits: true, balance: null }));
    expect((await chatgptAdapter.fetch(cred, opts)).extras?.["Credits"]).toBe("available");
  });

  it("maps 401 to auth and 403 to no-plan", async () => {
    mockFetch(401, { detail: "unauthorized" });
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
    mockFetch(403, { detail: "forbidden" });
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "no-plan" });
  });

  it("throws bad-response when rate_limit is missing", async () => {
    mockFetch(200, { plan_type: "plus" });
    await expect(chatgptAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("never copies PII fields into windows or extras", async () => {
    mockFetch(200, {
      plan_type: "plus",
      user_id: "user-secret-123",
      email: "someone@example.com",
      account_id: "acct-secret",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: 1792740597 },
      },
      credits: {},
    });
    const r = await chatgptAdapter.fetch(cred, opts);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("user-secret-123");
    expect(serialized).not.toContain("someone@example.com");
    expect(serialized).not.toContain("acct-secret");
  });
});

describe("chatgptPlan", () => {
  it("maps known plans", () => {
    expect(chatgptPlan("free")).toBe("ChatGPT Free");
    expect(chatgptPlan("plus")).toBe("ChatGPT Plus");
    expect(chatgptPlan("pro")).toBe("ChatGPT Pro");
    expect(chatgptPlan("enterprise")).toBe("ChatGPT Enterprise");
  });
  it("title-cases unknown plans and defaults", () => {
    expect(chatgptPlan("weird_plan")).toBe("Weird Plan");
    expect(chatgptPlan(null)).toBe("ChatGPT");
  });
});

describe("collectReports ChatGPT account-id redaction", () => {
  it("redacts the account id echoed in an error body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chatgpt-redact-"));
    const key = "tok-chatgpt-secret-123456";
    const accountId = "acct-echo-secret-123456";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: `unknown account ${accountId}` }), {
            status: 400,
          }),
      ),
    );

    const reports = await collectReports({
      providers: ["openai"],
      options: { fallback: false },
      env: {
        OPENCODE_DATA_HOME: dir,
        OPENCODE_USAGE_OPENAI_KEY: key,
        OPENCODE_USAGE_OPENAI_ACCOUNT_ID: accountId,
      } as unknown as NodeJS.ProcessEnv,
    });

    expect(reports[0].source).toBe("error");
    expect(reports[0].error).not.toContain(accountId);
    expect(JSON.stringify(reports[0])).not.toContain(accountId);
  });
});
