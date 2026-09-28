/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui";
import { For, createSignal } from "solid-js";
import { DEFAULT_OPTIONS, collectReports } from "./report";
import { coerceTuiOptions } from "./tui-format";
import { buildLines } from "./quota-lines";
import { UsageDialog } from "./context/dialog";
import { readCapture } from "./context/system";
import type { SystemCapture } from "./context/types";
import type { ProviderReport } from "./types";

/** Resolves the session the `/usage` dialog should describe, if any. */
function activeSessionID(api: TuiPluginApi): string | null {
  const route = api.route.current;
  if (route.name !== "session") return null;
  const id: unknown = route.params?.sessionID;
  return typeof id === "string" ? id : null;
}

export const tui: TuiPlugin = async (api, rawOptions) => {
  const options = coerceTuiOptions(rawOptions);

  const [reports, setReports] = createSignal<ProviderReport[]>([]);
  const [inFlight, setInFlight] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(Date.now());
  const [capture, setCapture] = createSignal<SystemCapture | null>(null);
  const [scope, setScope] = createSignal(0);
  const [showJson, setShowJson] = createSignal(false);

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

  // Single timer: refreshes data, advances countdowns, reloads the capture.
  const refreshCapture = async (): Promise<void> => {
    if (disposed) return;
    const sessionID = activeSessionID(api);
    if (sessionID === null) {
      setCapture(null);
      return;
    }
    setCapture(await readCapture(sessionID));
  };

  const intervalMs = Math.max(1, Math.floor(options.refreshIntervalSeconds)) * 1000;
  const timer = setInterval(() => {
    setTick(Date.now());
    void load();
    void refreshCapture();
  }, intervalMs);

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearInterval(timer);
  });

  const offIdle = api.event.on("session.idle", () => {
    setTick(Date.now());
    void load();
    void refreshCapture();
  });
  api.lifecycle.onDispose(offIdle);

  const openDialog = (): void => {
    const sessionID = activeSessionID(api);
    void refreshCapture().finally(() => {
      if (disposed) return;
      setScope(0);
      setShowJson(false);
      api.ui.dialog.replace(() => (
        <UsageDialog
          api={api}
          sessionID={sessionID}
          reports={reports}
          busy={busy}
          error={error}
          now={() => new Date(tick())}
          system={capture}
          scope={scope}
          showJson={showJson}
          barWidth={options.barWidth}
        />
      ));
      // Must follow replace(): the stack resets the size to "medium".
      api.ui.dialog.setSize("xlarge");
    });
  };

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
        {
          name: "usage.open",
          title: "Usage: open report",
          description: "Context usage and provider quota windows",
          category: "Plugin",
          namespace: "palette",
          slashName: "usage",
          run: openDialog,
        },
      ],
      bindings: [{ key: "ctrl+shift+u", cmd: "usage.refresh", desc: "Refresh usage panel" }],
    }),
  );

  // Scoped to the dialog's "modal" mode so these keys only fire while it is open.
  api.lifecycle.onDispose(
    api.keymap.registerLayer({
      mode: "modal",
      commands: [
        { name: "usage.dialog.refresh", run: () => void load(true) },
        {
          name: "usage.dialog.scope",
          run: () => {
            setScope((n) => (n + 1) % Math.max(1, reports().length + 1));
          },
        },
        {
          name: "usage.dialog.json",
          run: () => {
            setShowJson((v) => !v);
          },
        },
      ],
      bindings: [
        { key: "r", cmd: "usage.dialog.refresh", desc: "Refresh usage report" },
        { key: "tab", cmd: "usage.dialog.scope", desc: "Cycle provider scope" },
        { key: "j", cmd: "usage.dialog.json", desc: "Toggle raw JSON" },
      ],
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
