/**
 * System-prompt capture sidecar. The server plugin writes the fully joined
 * system prompt's size once per request; the TUI reads it back to split the
 * residual "System & tools" row. Every operation is best-effort and total:
 * failures degrade to `null` and must never break a request.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemCapture } from "./types";
import { pluginStateDir } from "../paths";

const CAPTURE_VERSION = 1;
const WRITE_THROTTLE_MS = 60_000;
const MAX_SESSION_ID_LENGTH = 200;

/** sessionID -> epoch ms of the last successful write, for throttling. */
const writeThrottle = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** <pluginStateDir>/context/<sanitized-sessionID>.json */
export function contextCapturePath(sessionID: string, env?: NodeJS.ProcessEnv): string {
  const raw = typeof sessionID === "string" ? sessionID : "";
  const safe =
    raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SESSION_ID_LENGTH) || "_";
  return join(pluginStateDir(env), "context", `${safe}.json`);
}

/**
 * Reads and validates a capture. Returns null for a missing/unreadable file,
 * invalid JSON, an unsupported version, a session mismatch, non-string
 * provider/model, or non-finite/negative sizes and timestamps.
 *
 * Deliberately independent of the write-throttle map: the server plugin writes
 * and the TUI plugin reads in separate processes, so a reader can never have a
 * throttle entry of its own.
 */
export async function readCapture(
  sessionID: string,
  env?: NodeJS.ProcessEnv,
): Promise<SystemCapture | null> {
  try {
    if (typeof sessionID !== "string") return null;

    const raw = await readFile(contextCapturePath(sessionID, env), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== CAPTURE_VERSION) return null;
    if (parsed.sessionID !== sessionID) return null;
    if (typeof parsed.providerID !== "string" || parsed.providerID === "") return null;
    if (typeof parsed.modelID !== "string" || parsed.modelID === "") return null;

    const systemChars = nonNegative(parsed.systemChars);
    const systemTokens = nonNegative(parsed.systemTokens);
    const capturedAt = nonNegative(parsed.capturedAt);
    if (systemChars === null || systemTokens === null || capturedAt === null) return null;

    return {
      version: CAPTURE_VERSION,
      sessionID,
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      systemChars,
      systemTokens,
      capturedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Atomically persists a capture (temp file + rename), throttled to at most one
 * write per session per 60 s unless the provider/model changed. Never throws.
 */
export async function writeCapture(
  capture: SystemCapture,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    if (!isRecord(capture)) return;
    const { sessionID, providerID, modelID } = capture;
    if (typeof sessionID !== "string" || sessionID === "") return;
    if (typeof providerID !== "string" || providerID === "") return;
    if (typeof modelID !== "string" || modelID === "") return;
    if (capture.version !== CAPTURE_VERSION) return;

    const systemChars = nonNegative(capture.systemChars);
    const systemTokens = nonNegative(capture.systemTokens);
    const capturedAt = nonNegative(capture.capturedAt);
    if (systemChars === null || systemTokens === null || capturedAt === null) return;

    const previous = await readCapture(sessionID, env);
    const modelChanged =
      previous === null ||
      previous.providerID !== providerID ||
      previous.modelID !== modelID;

    const now = Date.now();
    const last = writeThrottle.get(sessionID);
    if (!modelChanged && typeof last === "number" && now - last < WRITE_THROTTLE_MS) return;

    const directory = join(pluginStateDir(env), "context");
    await mkdir(directory, { recursive: true });
    const file = contextCapturePath(sessionID, env);
    const normalized: SystemCapture = {
      version: CAPTURE_VERSION,
      sessionID,
      providerID,
      modelID,
      systemChars,
      systemTokens,
      capturedAt,
    };
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(normalized), "utf8");
    await rename(tmp, file);
    writeThrottle.set(sessionID, now);
  } catch {
    // Capture writes are best-effort; a failure must never break a request.
  }
}

/**
 * True only when the capture matches the session/provider/model and was taken
 * at or after `since`.
 */
export function captureIsFresh(
  capture: SystemCapture | null | undefined,
  reference: { sessionID: string; providerID: string; modelID: string; since: number },
): boolean {
  if (!isRecord(capture)) return false;
  const ref = isRecord(reference) ? reference : null;
  if (ref === null) return false;
  if (capture.sessionID !== ref.sessionID) return false;
  if (capture.providerID !== ref.providerID) return false;
  if (capture.modelID !== ref.modelID) return false;
  const capturedAt = nonNegative(capture.capturedAt);
  const since = nonNegative(ref.since);
  if (capturedAt === null || since === null) return false;
  return capturedAt >= since;
}

/** Clears the write-throttle map so tests can reset between cases. */
export function resetCaptureThrottle(): void {
  writeThrottle.clear();
}
