import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { copilotAdapter, copilotTier } from "@/providers/copilot";

const cred = { type: "oauth" as const, key: "sk-copilot-key-123456" };
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
afterEach(() => vi.unstubAllGlobals());

describe("copilotAdapter", () => {
  it("parses the student fixture (unlimited snapshots + billed premium window)", async () => {
    mockFetch(200, fixture("copilot-student.json"));
    const r = await copilotAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    const w = r.windows[0];
    expect(w.kind).toBe("monthly");
    expect(w.usedPercent).toBe(0);
    expect(w.limit).toBe(200);
    expect(w.remaining).toBe(200);
    expect(w.resetsAt).toBe("2026-10-01T00:00:00.000Z");
    expect(r.extras?.["Plan"]).toBe("Copilot Student");
    expect(r.extras?.["Chat"]).toBe("unlimited");
    expect(r.extras?.["Completions"]).toBe("unlimited");
    expect(r.extras?.["Additional usage budget"]).toBe("$5.00");
  });

  it("parses the pro fixture", async () => {
    mockFetch(200, fixture("copilot-pro.json"));
    const r = await copilotAdapter.fetch(cred, opts);
    expect(r.windows).toHaveLength(1);
    expect(r.windows[0].usedPercent).toBe(3.3);
    expect(r.windows[0].limit).toBe(1500);
    expect(r.windows[0].remaining).toBe(1450);
    expect(r.extras?.["Plan"]).toBe("Copilot Pro");
    expect(r.extras?.["Credits used"]).toBe("50 credits ($0.50)");
  });

  it("uses 'Monthly premium requests' when token based billing is off", async () => {
    mockFetch(200, {
      token_based_billing: false,
      quota_snapshots: {
        premium_interactions: { percent_remaining: 50, entitlement: 100, remaining: 50 },
      },
    });
    const r = await copilotAdapter.fetch(cred, opts);
    expect(r.windows[0].label).toBe("Monthly premium requests");
  });

  it("marks a window rate-limited when remaining hits zero", async () => {
    mockFetch(200, {
      quota_snapshots: {
        premium_interactions: { percent_remaining: 100, entitlement: 100, remaining: 0 },
      },
    });
    const r = await copilotAdapter.fetch(cred, opts);
    expect(r.windows[0].status).toBe("rate-limited");
  });

  it("sends Authorization and User-Agent headers", async () => {
    mockFetch(200, fixture("copilot-student.json"));
    await copilotAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer sk-copilot-key-123456");
    expect(headers["User-Agent"]).toMatch(/^opencode-usage-report\//);
  });

  it("maps 401 and 404 to auth", async () => {
    mockFetch(401, { message: "Unauthorized" });
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
    mockFetch(404, { message: "Not Found" });
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
  });

  it("maps 403 to no-plan and 429 to rate-limited", async () => {
    mockFetch(403, { message: "Forbidden" });
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "no-plan" });
    mockFetch(429, { message: "Too Many Requests" });
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "rate-limited" });
  });

  it("maps a persistent 5xx to network after one retry", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never copies PII fields into windows or extras", async () => {
    mockFetch(200, {
      copilot_plan: "individual",
      login: "octocat-secret",
      email: "octo@example.com",
      analytics_tracking_id: "track-secret-123",
      user_id: 424242,
      quota_snapshots: {
        premium_interactions: { percent_remaining: 50, entitlement: 100, remaining: 50 },
      },
    });
    const r = await copilotAdapter.fetch(cred, opts);
    for (const serialized of [JSON.stringify(r.windows), JSON.stringify(r.extras)]) {
      expect(serialized).not.toContain("octocat-secret");
      expect(serialized).not.toContain("octo@example.com");
      expect(serialized).not.toContain("track-secret-123");
      expect(serialized).not.toContain("424242");
    }
  });

  it("throws bad-response when no snapshots are present", async () => {
    mockFetch(200, { copilot_plan: "individual" });
    await expect(copilotAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "bad-response" });
  });
});

describe("copilotTier", () => {
  it("maps SKUs before plans", () => {
    expect(copilotTier("pro_plus", "individual")).toBe("Copilot Pro+");
    expect(copilotTier("copilot_for_business", "business")).toBe("Copilot Business");
    expect(copilotTier("", "enterprise")).toBe("Copilot Enterprise");
    expect(copilotTier(null, null)).toBe("Copilot");
  });
  it("falls back to free/plan/title-case", () => {
    expect(copilotTier("free", "individual")).toBe("Copilot Free");
    expect(copilotTier("free_trial", "individual")).toBe("Copilot Free");
    expect(copilotTier("copilot_pro", "individual")).toBe("Copilot Pro");
    expect(copilotTier("something_else", "weird_plan")).toBe("Weird Plan");
  });
});
