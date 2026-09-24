/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui";
import { For, createSignal } from "solid-js";
import { DEFAULT_OPTIONS, collectReports } from "./report";
import { bar, coerceTuiOptions, countdown, percentText, toneFor, windowLabel } from "./tui-format";
import type { ProviderReport, WindowKind } from "./types";

type Theme = TuiPluginApi["theme"]["current"];
type ThemeColor = Theme["text"];

interface Segment {
  text: string;
  fg: ThemeColor;
  bold?: boolean;
}

interface Line {
  segments: Segment[];
}

const NAMED_WIDTH = 14;
const EXTRAS_MAX_LENGTH = 80;

/** Order windows for display; unknown kinds sort last. */
const WINDOW_ORDER: Record<WindowKind, number> = {
  "5h": 0,
  weekly: 1,
  monthly: 2,
  daily: 3,
  other: 4,
};

function windowRank(kind: WindowKind): number {
  return WINDOW_ORDER[kind] ?? WINDOW_ORDER.other;
}

/** Collapses whitespace and truncates to a single-line label. */
function clip(value: string, max = 60): string {
  const single = value.replace(/\s+/g, " ").trim();
  if (single.length <= max) return single;
  return single.slice(0, Math.max(0, max - 1)) + "…";
}

/** Pads a label to a fixed width, truncating (with a trailing space) when long. */
function alignLabel(label: string): string {
  const text = label.length > NAMED_WIDTH ? label.slice(0, NAMED_WIDTH - 1) + " " : label;
  return text.padEnd(NAMED_WIDTH);
}

/** Flattens the current signal state into plain, pre-colored text lines. */
function buildLines(
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

    const windows = report.windows.toSorted((a, b) => windowRank(a.kind) - windowRank(b.kind));
    for (const w of windows) {
      const tone = toneFor(w.usedPercent, w.status);
      const row: Segment[] = [
        { text: alignLabel(windowLabel(w.kind, w.label)), fg: theme.textMuted },
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

export const tui: TuiPlugin = async (api, rawOptions) => {
  const options = coerceTuiOptions(rawOptions);

  const [reports, setReports] = createSignal<ProviderReport[]>([]);
  const [inFlight, setInFlight] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(Date.now());

  const busy = (): boolean => inFlight() > 0;

  let disposed = false;

  const load = async (refresh = false): Promise<void> => {
    if (disposed) return;
    setInFlight((n) => n + 1);
    try {
      const result = await collectReports({
        providers: options.providers,
        refresh,
        options: {
          ...DEFAULT_OPTIONS,
          cacheTtlSeconds: options.cacheTtlSeconds,
          thresholdPercent: options.thresholdPercent,
        },
      });
      if (disposed) return;
      setReports(result);
      setError(null);
    } catch (err) {
      if (disposed) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInFlight((n) => Math.max(0, n - 1));
    }
  };

  // Single timer: refreshes data and advances countdowns.
  const intervalMs = Math.max(1, Math.floor(options.refreshIntervalSeconds)) * 1000;
  const timer = setInterval(() => {
    setTick(Date.now());
    void load();
  }, intervalMs);

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(timer);
  });

  const offIdle = api.event.on("session.idle", () => {
    setTick(Date.now());
    void load();
  });
  api.lifecycle.onDispose(offIdle);

  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      commands: [
        {
          name: "usage.refresh",
          title: "Usage: refresh now",
          category: "Plugin",
          namespace: "palette",
          run: () => {
            void load(true);
          },
        },
      ],
      bindings: [{ key: "ctrl+shift+u", cmd: "usage.refresh", desc: "Refresh usage panel" }],
    }),
  );

  const slot: TuiSlotPlugin = {
    order: 150,
    slots: {
      sidebar_content(ctx) {
        const theme = ctx.theme.current;
        return (
          <box flexDirection="column">
            <text fg={theme.text}>
              <b>Usage</b>
            </text>
            <For
              each={buildLines(
                theme,
                reports(),
                busy(),
                error(),
                new Date(tick()),
                options.barWidth,
              )}
            >
              {(line) => (
                <text>
                  {line.segments.map((seg) =>
                    seg.bold ? (
                      <b style={{ fg: seg.fg }}>{seg.text}</b>
                    ) : (
                      <span style={{ fg: seg.fg }}>{seg.text}</span>
                    ),
                  )}
                </text>
              )}
            </For>
          </box>
        );
      },
    },
  };

  api.slots.register(slot);

  void load();
};

const plugin: TuiPluginModule & { id: string } = { id: "usage-report", tui };
export default plugin;
