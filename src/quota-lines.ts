/**
 * Pure line-building for the sidebar quota panel, extracted verbatim from
 * `src/tui.tsx` so the formatting can be unit-tested and later reused by the
 * `/usage` dialog. No JSX and no Solid imports (only the shared formatting
 * helpers and types).
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { ProviderReport, WindowKind } from "./types";
import { bar, clip, countdown, padLabel, percentText, toneFor, windowLabel } from "./tui-format";

type Theme = TuiPluginApi["theme"]["current"];
type ThemeColor = Theme["text"];

export interface Segment {
  text: string;
  fg: ThemeColor;
  bold?: boolean;
}

export interface Line {
  segments: Segment[];
}

export const NAMED_WIDTH = 14;
export const EXTRAS_MAX_LENGTH = 80;

/** Order windows for display; unknown kinds sort last. */
const WINDOW_ORDER: Record<WindowKind, number> = {
  "5h": 0,
  weekly: 1,
  monthly: 2,
  daily: 3,
  other: 4,
};

/** Flattens provider reports into plain, pre-colored text lines. */
export function buildLines(
  theme: Theme,
  reports: ProviderReport[],
  busy: boolean,
  error: string | null,
  now: Date,
  barWidth: number,
): Line[] {
  const lines: Line[] = [];

  if (error !== null) {
    lines.push({
      segments: [{ text: `api error: ${clip(error)}`, fg: theme.error }],
    });
  }

  if (reports.length === 0 && busy) {
    lines.push({
      segments: [{ text: "loading…", fg: theme.textMuted }],
    });
  }

  for (const report of reports) {
    const nameColor = report.source === "error" ? theme.textMuted : theme.accent;
    const segments: Segment[] = [{ text: report.displayName, fg: nameColor, bold: true }];
    if (report.stale) segments.push({ text: " (stale)", fg: theme.textMuted });
    if (report.source === "local-estimate") {
      segments.push({ text: " (est)", fg: theme.textMuted });
    }
    lines.push({ segments });

    if (report.source === "error") {
      lines.push({
        segments: [{ text: clip(report.error ?? "unknown error"), fg: theme.error }],
      });
      continue;
    }

    const windows = report.windows.toSorted((a, b) => WINDOW_ORDER[a.kind] - WINDOW_ORDER[b.kind]);
    for (const w of windows) {
      const tone = toneFor(w.usedPercent, w.status);
      const row: Segment[] = [
        { text: padLabel(windowLabel(w.kind, w.label), NAMED_WIDTH), fg: theme.textMuted },
        { text: bar(w.usedPercent, barWidth), fg: theme[tone] },
        { text: " ", fg: theme.text },
        { text: percentText(w), fg: theme.text },
      ];
      const reset = countdown(w.resetsAt, now);
      if (reset !== null) {
        row.push({ text: ` resets in ${reset}`, fg: theme.textMuted });
      }
      lines.push({ segments: row });
    }

    for (const [key, value] of Object.entries(report.extras)) {
      lines.push({
        segments: [{ text: clip(`${key}: ${value}`, EXTRAS_MAX_LENGTH), fg: theme.textMuted }],
      });
    }
  }

  return lines;
}
