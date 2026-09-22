import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVarName, resolveCredential, redact } from "../src/auth.js";

describe("envVarName", () => {
  it("normalizes provider ids", () => {
    expect(envVarName("kimi-code-plan-global")).toBe("OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY");
  });
});
describe("resolveCredential", () => {
  afterEach(() => { delete process.env.OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY; });
  it("prefers env override", () => {
    process.env.OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY = "sk-env";
    expect(resolveCredential("kimi-code-plan-global")?.key).toBe("sk-env");
  });
  it("reads api key from auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimi-code-plan-global": { type: "api", key: "sk-file" } }));
    expect(resolveCredential("kimi-code-plan-global", { dataHomeDir: dir })?.key).toBe("sk-file");
  });
  it("reads oauth access token", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ p: { type: "oauth", access: "tok" } }));
    expect(resolveCredential("p", { dataHomeDir: dir })).toEqual({ type: "oauth", key: "tok" });
  });
  it("returns null for missing entry / malformed json / empty env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    expect(resolveCredential("nope", { dataHomeDir: dir })).toBeNull();
    writeFileSync(join(dir, "auth.json"), "{bad json");
    expect(resolveCredential("kimi-code-plan-global", { dataHomeDir: dir })).toBeNull();
    process.env.OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY = "";
    expect(resolveCredential("kimi-code-plan-global", { dataHomeDir: dir })).toBeNull();
  });
});
describe("redact", () => {
  it("replaces key material", () => {
    expect(redact("failed with sk-kimi-secret-123: unauthorized", "sk-kimi-secret-123")).toBe("failed with <redacted>: unauthorized");
  });
  it("ignores short/null keys", () => {
    expect(redact("abc", "ab")).toBe("abc");
    expect(redact("abc", null)).toBe("abc");
  });
});
