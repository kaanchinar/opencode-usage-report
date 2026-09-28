/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { AssistantMessage, Model } from "@opencode-ai/sdk/v2";
import { For, Show, createMemo } from "solid-js";
import { buildContextLines, type ContextTone } from "./format";
import { collectContext } from "./collect";
import { captureIsFresh } from "./system";
import type { ContextBreakdown, SystemCapture } from "./types";
import { buildLines } from "../quota-lines";
import type { ProviderReport } from "../types";

type Theme = TuiPluginApi["theme"]["current"];

const GRID_COLS = 48;

export interface UsageDialogProps {
  api: TuiPluginApi;
  sessionID: string | null;
  /** Accessors, not values: the dialog must stay live while the dialog is open. */
  reports: () => ProviderReport[];
  busy: () => boolean;
  error: () => string | null;
  now: () => Date;
  system: () => SystemCapture | null;
  scope: () => number;
  showJson: () => boolean;
  barWidth: number;
}

/**
 * A rendered line. `fg` is either a theme color name (context block) or an
 * already-resolved RGBA (quota block), so both feeds share one renderer.
 */
interface RenderedLine {
  segments: { text: string; fg: unknown; bold?: boolean }[];
}

function resolveColor(theme: Theme, fg: unknown) {
  return typeof fg === "string" ? theme[fg as ContextTone] : fg;
}

/** Renders pre-colored lines; shared by the context, quota and raw blocks. */
function Lines(props: { lines: RenderedLine[]; theme: Theme }) {
  return (
    <For each={props.lines}>
      {(line) => (
        <text>
          {line.segments.map((seg) => {
            const color = resolveColor(props.theme, seg.fg);
            return seg.bold ? (
              <b style={{ fg: color }}>{seg.text}</b>
            ) : (
              <span style={{ fg: color }}>{seg.text}</span>
            );
          })}
        </text>
      )}
    </For>
  );
}

function jsonLines(value: unknown): RenderedLine[] {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? "";
  } catch {
    text = "{}";
  }
  return text.split("\n").map((row) => ({ segments: [{ text: row, fg: "textMuted" as const }] }));
}

/** The `/usage` dialog: context usage on top, the existing quota output below. */
export function UsageDialog(props: UsageDialogProps) {
  const theme = () => props.api.theme.current;

  const messages = createMemo(() =>
    props.sessionID === null ? [] : props.api.state.session.messages(props.sessionID),
  );
  const reference = createMemo(() =>
    messages().findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    ),
  );
  const model = createMemo<Model | undefined>(() => {
    const last = reference();
    if (last === undefined) return undefined;
    return props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID];
  });

  /** The capture only counts when it matches this message's session, model and turn. */
  const freshCapture = createMemo<SystemCapture | null>(() => {
    const last = reference();
    const capture = props.system();
    if (last === undefined || capture === null) return null;
    const ok = captureIsFresh(capture, {
      sessionID: last.sessionID,
      providerID: last.providerID,
      modelID: last.modelID,
      since: last.time?.created ?? 0,
    });
    return ok ? capture : null;
  });

  const scopedReports = createMemo(() => {
    const all = props.reports();
    if (props.scope() <= 0) return all;
    const target = all[props.scope() - 1];
    return target === undefined ? all : [target];
  });

  const breakdown = createMemo<ContextBreakdown>(() =>
    collectContext({
      messages: messages(),
      model: model() ?? null,
      part: (messageID) => props.api.state.part(messageID),
      system: freshCapture(),
      sessionCost:
        props.sessionID === null ? 0 : (props.api.state.session.get(props.sessionID)?.cost ?? 0),
      cols: GRID_COLS,
      compaction: props.api.state.config?.compaction ?? null,
    }),
  );

  const modelLabel = createMemo(() => {
    const last = reference();
    return last === undefined ? null : `${last.providerID}/${last.modelID}`;
  });

  const contextLines = createMemo(() => buildContextLines(breakdown(), { modelLabel: modelLabel() }));
  const quotaLines = createMemo(() =>
    buildLines(theme(), scopedReports(), props.busy(), props.error(), props.now(), props.barWidth),
  );
  const rawLines = createMemo(() => jsonLines({ context: breakdown(), reports: scopedReports() }));

  const footer = createMemo(() => {
    const hints = ["esc close"];
    if (props.reports().length > 1) {
      const current = props.scope() <= 0 ? "all" : (scopedReports()[0]?.provider ?? "?");
      hints.push(`tab scope: ${current}`);
    }
    hints.push("r refresh", "j json");
    return hints.join("  ·  ");
  });

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>Usage</b>
        </text>
        <text fg={theme().textMuted}>{footer()}</text>
      </box>

      <Show
        when={!props.showJson()}
        fallback={
          <box flexDirection="column" gap={1}>
            <text fg={theme().accent}>
              <b>Raw</b>
            </text>
            <Lines lines={rawLines()} theme={theme()} />
          </box>
        }
      >
        <box flexDirection="column">
          <text fg={theme().accent}>
            <b>Context</b>
          </text>
          <Lines lines={contextLines()} theme={theme()} />
        </box>

        <text fg={theme().borderSubtle}>{"─".repeat(100)}</text>

        <box flexDirection="column">
          <Lines lines={quotaLines()} theme={theme()} />
        </box>
      </Show>
    </box>
  );
}
