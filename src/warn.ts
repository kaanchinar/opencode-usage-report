import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderReport, UsageWindow } from "./types.js";
import { pluginStateDir } from "./paths.js";
import { formatReset } from "./render.js";

export interface WarnHit {
  provider: string;
  displayName: string;
  window: UsageWindow;
  message: string;
}

interface WarnEntry {
  firedAtReset: string | null;
}
type WarnState = Record<string, WarnEntry>;

const HITS_WINDOW_STATUSES = new Set<UsageWindow["status"]>(["rate-limited", "frozen"]);
const REARM_HYSTERESIS = 10;

function buildMessage(displayName: string, w: UsageWindow, now: Date): string {
  const base = `${displayName} ${w.label} window`;
  if (HITS_WINDOW_STATUSES.has(w.status)) {
    return `${base} is ${w.status === "rate-limited" ? "rate-limited" : "frozen"}`;
  }
  let message = `${base} at ${w.usedPercent}%`;
  if (w.resetsAt !== null) {
    const reset = formatReset(w.resetsAt, now);
    if (reset !== null) message += ` (resets ${reset})`;
  }
  return message;
}

function readState(file: string): WarnState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as WarnState;
    }
  } catch {
    // Missing or corrupt state file: start from empty.
  }
  return {};
}

/** Atomic: write a temp file next to the target, then rename it into place. */
function writeState(file: string, dir: string, state: WarnState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

/**
 * Checks reports for windows that crossed the warning threshold or are
 * rate-limited/frozen. Fires at most once per (provider, window-kind) until the
 * window resets; re-arms once usage drops below threshold - 10.
 */
export async function checkWarnings(
  reports: ProviderReport[],
  thresholdPercent: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WarnHit[]> {
  const now = new Date();
  const dir = pluginStateDir(env);
  const file = join(dir, "warn-state.json");
  const state = readState(file);
  const hits: WarnHit[] = [];

  for (const report of reports) {
    for (const w of report.windows) {
      const key = `${report.provider}/${w.kind}`;
      const crossed =
        (w.usedPercent !== null && w.usedPercent >= thresholdPercent) || HITS_WINDOW_STATUSES.has(w.status);

      if (crossed) {
        const prev = state[key];
        const alreadyFired = prev !== undefined && prev.firedAtReset === w.resetsAt;
        if (!alreadyFired) {
          state[key] = { firedAtReset: w.resetsAt };
          hits.push({
            provider: report.provider,
            displayName: report.displayName,
            window: w,
            message: buildMessage(report.displayName, w, now),
          });
        }
      } else if (w.usedPercent !== null && w.usedPercent < thresholdPercent - REARM_HYSTERESIS) {
        delete state[key];
      }
    }
  }

  writeState(file, dir, state);
  return hits;
}
