import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { opencodeGoAdapter } from "@/providers/opencode-go";

const cred = { type: "api" as const, key: "sk-go-key-123456" };
const opts = { timeoutMs: 1000, sessionId: "sess-1" };
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

describe("opencodeGoAdapter", () => {
  it("parses canonical windows", async () => {
    mockFetch(200, fixture("go-canonical.json"));
    const r = await opencodeGoAdapter.fetch(cred, opts);
    expect(r.windows.map((w) => w.kind)).toEqual(["5h", "weekly", "monthly"]);
    expect(r.windows[1].usedPercent).toBe(57);
    expect(r.windows[2].resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });
  it("maps rate-limited status", async () => {
    mockFetch(200, {
      usage: {
        rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-09-16T13:40:00Z" },
      },
    });
    const r = await opencodeGoAdapter.fetch(cred, opts);
    expect(r.windows[0].status).toBe("rate-limited");
  });
  it("sends custom UA and session header", async () => {
    mockFetch(200, fixture("go-minimal.json"));
    await opencodeGoAdapter.fetch(cred, opts);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers["User-Agent"]).toMatch(/^opencode-usage-report\//);
    expect(headers["x-opencode-session"]).toBe("sess-1");
  });
  it("maps 403 EntitlementError to no-plan", async () => {
    mockFetch(403, {
      type: "error",
      error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
    });
    await expect(opencodeGoAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "no-plan" });
  });
  it("maps 401 to auth", async () => {
    mockFetch(401, { type: "error", error: { type: "AuthError" } });
    await expect(opencodeGoAdapter.fetch(cred, opts)).rejects.toMatchObject({ kind: "auth" });
  });
});
