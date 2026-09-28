import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureIsFresh,
  contextCapturePath,
  readCapture,
  resetCaptureThrottle,
  writeCapture,
} from "@/context/system";
import type { SystemCapture } from "@/context/types";

const env = (dir: string) => ({ OPENCODE_DATA_HOME: dir }) as unknown as NodeJS.ProcessEnv;

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "ctxcap-"));
}

function capture(overrides: Partial<SystemCapture> = {}): SystemCapture {
  return {
    version: 1,
    sessionID: "s1",
    providerID: "p1",
    modelID: "m1",
    systemChars: 100,
    systemTokens: 25,
    capturedAt: 1,
    ...overrides,
  };
}

async function armed(): Promise<{ dir: string; file: string }> {
  resetCaptureThrottle();
  const dir = makeDir();
  await writeCapture(capture(), env(dir));
  return { dir, file: contextCapturePath("s1", env(dir)) };
}

describe("context capture sidecar", () => {
  beforeEach(() => resetCaptureThrottle());
  afterEach(() => vi.useRealTimers());

  it("round-trips a capture", async () => {
    const dir = makeDir();
    await writeCapture(capture(), env(dir));
    expect(await readCapture("s1", env(dir))).toEqual(capture());
  });

  it("honours the OPENCODE_DATA_HOME override", async () => {
    const dir = makeDir();
    await writeCapture(capture(), env(dir));
    const file = contextCapturePath("s1", env(dir));
    expect(existsSync(file)).toBe(true);
    expect(file).toContain(join(dir, "usage-report", "context"));
  });

  it("reads a capture written by another process (no local throttle entry)", async () => {
    const dir = makeDir();
    await writeCapture(capture({ systemTokens: 25 }), env(dir));
    // A fresh module instance is what the TUI plugin sees: the server plugin
    // wrote the file, this process never did.
    resetCaptureThrottle();
    expect(await readCapture("s1", env(dir))).not.toBeNull();
  });

  it("throttles a second write within 60s", async () => {
    const dir = makeDir();
    await writeCapture(capture({ systemTokens: 25 }), env(dir));
    await writeCapture(capture({ systemTokens: 99 }), env(dir));
    expect((await readCapture("s1", env(dir)))?.systemTokens).toBe(25);
  });

  it("allows a write after 60s", async () => {
    const dir = makeDir();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await writeCapture(capture({ systemTokens: 25 }), env(dir));
    vi.setSystemTime(60_001);
    await writeCapture(capture({ systemTokens: 99 }), env(dir));
    expect((await readCapture("s1", env(dir)))?.systemTokens).toBe(99);
  });

  it("bypasses the throttle when the model changes", async () => {
    const dir = makeDir();
    await writeCapture(capture({ modelID: "m1", systemTokens: 25 }), env(dir));
    await writeCapture(capture({ modelID: "m2", systemTokens: 99 }), env(dir));
    expect((await readCapture("s1", env(dir)))?.modelID).toBe("m2");
  });

  it("allows a write after resetCaptureThrottle with a changed model", async () => {
    const dir = makeDir();
    await writeCapture(capture({ modelID: "m1", systemTokens: 25 }), env(dir));
    resetCaptureThrottle();
    await writeCapture(capture({ modelID: "m2", systemTokens: 42 }), env(dir));
    const read = await readCapture("s1", env(dir));
    expect(read?.modelID).toBe("m2");
    expect(read?.systemTokens).toBe(42);
  });

  it("does not corrupt the previous file when throttled", async () => {
    const dir = makeDir();
    await writeCapture(capture({ systemTokens: 25 }), env(dir));
    await writeCapture(capture({ systemTokens: 99 }), env(dir));
    const raw = JSON.parse(readFileSync(contextCapturePath("s1", env(dir)), "utf8")) as {
      systemTokens: number;
    };
    expect(raw.systemTokens).toBe(25);
  });

  it("leaves no temp file behind after an atomic write", async () => {
    const dir = makeDir();
    await writeCapture(capture(), env(dir));
    expect(readdirSync(join(dir, "usage-report", "context"))).toEqual(["s1.json"]);
  });

  it("cannot escape the context directory with a crafted session id", () => {
    const dir = makeDir();
    const root = join(dir, "usage-report", "context");
    const path = contextCapturePath("../evil", env(dir));
    expect(path.startsWith(root)).toBe(true);
    expect(path).not.toContain("..");
    expect(path).not.toContain("/evil");
  });

  it("reads a sidecar dropped on disk by the server process", async () => {
    const dir = makeDir();
    mkdirSync(join(dir, "usage-report", "context"), { recursive: true });
    writeFileSync(contextCapturePath("s1", env(dir)), JSON.stringify(capture()));
    expect((await readCapture("s1", env(dir)))?.systemTokens).toBe(25);
  });
});

describe("readCapture rejection", () => {
  beforeEach(() => resetCaptureThrottle());
  afterEach(() => vi.useRealTimers());

  it("returns null when the file is missing", async () => {
    const { dir, file } = await armed();
    unlinkSync(file);
    expect(await readCapture("s1", env(dir))).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const { dir, file } = await armed();
    writeFileSync(file, "{not json");
    expect(await readCapture("s1", env(dir))).toBeNull();
  });

  it("returns null for empty and truncated files", async () => {
    const empty = await armed();
    writeFileSync(empty.file, "");
    expect(await readCapture("s1", env(empty.dir))).toBeNull();

    const truncated = await armed();
    writeFileSync(truncated.file, '{"version":1,"sessionID":"s1"');
    expect(await readCapture("s1", env(truncated.dir))).toBeNull();
  });

  it("returns null for an unsupported version", async () => {
    const { dir, file } = await armed();
    writeFileSync(file, JSON.stringify({ ...capture(), version: 2 }));
    expect(await readCapture("s1", env(dir))).toBeNull();
  });

  it("returns null for a session mismatch", async () => {
    const { dir, file } = await armed();
    writeFileSync(file, JSON.stringify({ ...capture(), sessionID: "other" }));
    expect(await readCapture("s1", env(dir))).toBeNull();
  });

  it("returns null for a non-string provider", async () => {
    const { dir, file } = await armed();
    const bad = { ...capture(), providerID: 5 } as unknown as SystemCapture;
    writeFileSync(file, JSON.stringify(bad));
    expect(await readCapture("s1", env(dir))).toBeNull();
  });

  it("returns null for non-finite and negative systemTokens", async () => {
    const infinite = await armed();
    writeFileSync(
      infinite.file,
      '{"version":1,"sessionID":"s1","providerID":"p1","modelID":"m1","systemChars":10,"systemTokens":1e999,"capturedAt":1}',
    );
    expect(await readCapture("s1", env(infinite.dir))).toBeNull();

    const negative = await armed();
    writeFileSync(negative.file, JSON.stringify({ ...capture(), systemTokens: -5 }));
    expect(await readCapture("s1", env(negative.dir))).toBeNull();
  });
});

describe("captureIsFresh", () => {
  it("requires matching session, provider and model plus capturedAt >= since", () => {
    const cap = capture();
    const ref = { sessionID: "s1", providerID: "p1", modelID: "m1", since: 1 };
    expect(captureIsFresh(cap, ref)).toBe(true);
    expect(captureIsFresh(cap, { ...ref, since: 2 })).toBe(false);
    expect(captureIsFresh(cap, { ...ref, sessionID: "x" })).toBe(false);
    expect(captureIsFresh(cap, { ...ref, providerID: "x" })).toBe(false);
    expect(captureIsFresh(cap, { ...ref, modelID: "x" })).toBe(false);
    expect(captureIsFresh(null, ref)).toBe(false);
    expect(captureIsFresh(capture({ capturedAt: Number.NaN }), ref)).toBe(false);
  });
});
