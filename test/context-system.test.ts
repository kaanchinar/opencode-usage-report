import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureIsFresh, contextCapturePath, readCapture, writeCapture } from "@/context/system";
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
  const dir = makeDir();
  await writeCapture(capture(), env(dir));
  return { dir, file: contextCapturePath("s1", env(dir)) };
}

describe("context capture sidecar", () => {
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
