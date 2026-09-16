import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVarName, resolveCredential, redact } from "../src/auth.js";

describe("envVarName", () => {
  it("normalizes provider ids", () => {
    expect(envVarName("kimi-for-coding")).toBe("OPENCODE_USAGE_KIMI_FOR_CODING_KEY");
  });
});
describe("resolveCredential", () => {
  afterEach(() => { delete process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY; });
  it("prefers env override", () => {
    process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY = "sk-env";
    expect(resolveCredential("kimi-for-coding")?.key).toBe("sk-env");
  });
  it("reads api key from auth.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimi-for-coding": { type: "api", key: "sk-file" } }));
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })?.key).toBe("sk-file");
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
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })).toBeNull();
    process.env.OPENCODE_USAGE_KIMI_FOR_CODING_KEY = "";
    expect(resolveCredential("kimi-for-coding", { dataHomeDir: dir })).toBeNull();
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
