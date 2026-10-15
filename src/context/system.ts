/**
 * System-prompt capture sidecar. The server plugin writes the fully joined
 * system prompt's size once per request; the TUI reads it back to split the
 * residual "System & tools" row. Every operation is best-effort and total:
 * failures degrade to `null` and must never break a request.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SystemCapture } from "./types";
import { isRecord, nonNegative } from "../normalize";
import { pluginStateDir } from "../paths";

const CAPTURE_VERSION = 1;
const MAX_SESSION_ID_LENGTH = 200;

/** <pluginStateDir>/context/<sanitized-sessionID>.json */
export function contextCapturePath(sessionID: string, env?: NodeJS.ProcessEnv): string {
  const raw = typeof sessionID === "string" ? sessionID : "";
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_SESSION_ID_LENGTH) || "_";
  return join(pluginStateDir(env), "context", `${safe}.json`);
}

/**
 * Reads and validates a capture. Returns null for a missing/unreadable file,
 * invalid JSON, an unsupported version, a session mismatch, non-string
 * provider/model, or non-finite/negative sizes and timestamps.
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

/** Atomically persists a capture (temp file + rename). Never throws. */
export async function writeCapture(capture: SystemCapture, env?: NodeJS.ProcessEnv): Promise<void> {
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
  // A zero boundary means the caller had no usable timestamp — treat it as
  // unusable rather than "anything is fresh" (epoch 0 is never a real turn).
  if (capturedAt === null || since === null || since === 0) return false;
  return capturedAt >= since;
}

function messageCreated(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const time = isRecord(value.time) ? value.time : {};
  const created = nonNegative(time.created);
  return created !== null && created > 0 ? created : null;
}

/**
 * The `since` boundary for `captureIsFresh`: the creation time of the user
 * message that started the turn `reference` belongs to, falling back to the
 * reference's own creation time. Returns `0` when neither carries a usable
 * timestamp, which `captureIsFresh` rejects.
 *
 * OpenCode 2 assembles the request — firing the system-transform hook — just
 * before the assistant message row gets its `time.created`, so a capture from
 * the current turn is a few milliseconds *older* than the message and the old
 * `capturedAt >= message.created` boundary rejected every fresh capture. The
 * turn's user message predates request assembly under both OpenCode 1 and 2,
 * so it is an ordering-stable boundary; a capture written for an earlier turn
 * still sits before it and is still rejected.
 */
export function captureSince(messages: readonly unknown[], reference: unknown): number {
  const list = Array.isArray(messages) ? messages : [];
  const index = list.indexOf(reference);
  const start = index === -1 ? list.length : index;
  for (let i = start - 1; i >= 0; i--) {
    const message = list[i];
    if (!isRecord(message) || message.role !== "user") continue;
    const created = messageCreated(message);
    if (created !== null) return created;
  }
  return messageCreated(reference) ?? 0;
}
