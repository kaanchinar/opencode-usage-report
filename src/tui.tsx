/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { For, createSignal } from "solid-js";
import { DEFAULT_OPTIONS, collectReports } from "./report";
import { coerceTuiOptions, type ResolvedTuiOptions } from "./tui-format";
import { buildLines } from "./quota-lines";
import { UsageDialog } from "./context/dialog";
import { readCapture } from "./context/system";
import type { SystemCapture } from "./context/types";
import type { ProviderReport } from "./types";
import { asV1Theme, createV2Api, v2ThemeColors, type V2Context } from "./v2-tui";

type Theme = TuiPluginApi["theme"]["current"];

/** Resolves the session the `/usage` dialog should describe, if any. */
function activeSessionID(api: TuiPluginApi): string | null {
  const route = api.route.current;
  if (route.name !== "session") return null;
  const id: unknown = route.params?.sessionID;
  return typeof id === "string" ? id : null;
}

/**
 * Shared panel state: the report cache, the refresh timer and the system-prompt
 * capture. Built once per plugin load and driven by both the V1 and V2 halves.
 */
function createUsagePanel(getSessionID: () => string | null, options: ResolvedTuiOptions) {
  const [reports, setReports] = createSignal<ProviderReport[]>([]);
  const [inFlight, setInFlight] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(Date.now());
  const [capture, setCapture] = createSignal<SystemCapture | null>(null);
  const [scope, setScope] = createSignal(0);
  const [showJson, setShowJson] = createSignal(false);
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

  const refreshCapture = async (): Promise<void> => {
    if (disposed) return;
    const sessionID = getSessionID();
    if (sessionID === null) {
      setCapture(null);
      return;
    }
    setCapture(await readCapture(sessionID));
  };

  const refresh = (): void => {
    setTick(Date.now());
    void load();
    void refreshCapture();
  };

  const timer = setInterval(
    refresh,
    Math.max(1, Math.floor(options.refreshIntervalSeconds)) * 1000,
  );

  return {
    reports,
    error,
    tick,
    capture,
    scope,
    showJson,
    setScope,
    setShowJson,
    load,
    refreshCapture,
    refresh,
    busy: (): boolean => inFlight() > 0,
    isDisposed: (): boolean => disposed,
    dispose: (): void => {
      disposed = true;
      clearInterval(timer);
    },
  };
}

type UsagePanel = ReturnType<typeof createUsagePanel>;

/** The sidebar quota panel; shared verbatim by the V1 and V2 halves. */
function UsageSidebar(props: {
  theme: () => Theme;
  reports: () => ProviderReport[];
  busy: () => boolean;
  error: () => string | null;
  tick: () => number;
  barWidth: number;
}) {
  return (
    <box flexDirection="column">
      <text fg={props.theme().text}>
        <b>Usage</b>
      </text>
      <For
        each={buildLines(
          props.theme(),
          props.reports(),
          props.busy(),
          props.error(),
          new Date(props.tick()),
          props.barWidth,
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
}

// ---------------------------------------------------------------------------
// OpenCode 1.x (V1) TUI plugin API.
// ---------------------------------------------------------------------------

export const tui: TuiPlugin = async (api, rawOptions) => {
  const options = coerceTuiOptions(rawOptions);
  const panel = createUsagePanel(() => activeSessionID(api), options);

  api.lifecycle.onDispose(panel.dispose);
  api.lifecycle.onDispose(api.event.on("session.idle", panel.refresh));

  const openDialog = (): void => {
    const sessionID = activeSessionID(api);
    void panel.refreshCapture().finally(() => {
      if (panel.isDisposed()) return;
      panel.setScope(0);
      panel.setShowJson(false);
      api.ui.dialog.replace(() => (
        <UsageDialog
          api={api}
          sessionID={sessionID}
          reports={panel.reports}
          busy={panel.busy}
          error={panel.error}
          now={() => new Date(panel.tick())}
          system={panel.capture}
          scope={panel.scope}
          showJson={panel.showJson}
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
            void panel.load(true);
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
        { name: "usage.dialog.refresh", run: () => void panel.load(true) },
        {
          name: "usage.dialog.scope",
          run: () => {
            panel.setScope((n) => (n + 1) % Math.max(1, panel.reports().length + 1));
          },
        },
        {
          name: "usage.dialog.json",
          run: () => {
            panel.setShowJson((v) => !v);
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

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(ctx) {
        return (
          <UsageSidebar
            theme={() => ctx.theme.current}
            reports={panel.reports}
            busy={panel.busy}
            error={panel.error}
            tick={panel.tick}
            barWidth={options.barWidth}
          />
        );
      },
    },
  });

  void panel.load();
};

// ---------------------------------------------------------------------------
// OpenCode 2.x (V2) TUI plugin API.
// ---------------------------------------------------------------------------

/**
 * V2 command layer, mounted through a headless `app`-slot component because
 * `keymap.layer` is a Solid context owned by the calling component: calling it
 * from `setup` throws "Keymap.Provider is missing" and takes the whole plugin
 * down. The layer is `global` so the palette/slash entry stays reachable.
 */
function V2CommandLayer(props: {
  ctx: V2Context;
  open: () => void;
  refresh: () => void;
  panel: UsagePanel;
}) {
  props.ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "usage.open",
        title: "Usage: open report",
        description: "Context usage and provider quota windows",
        group: "Usage",
        palette: true,
        slash: { name: "usage" },
        run: () => props.open(),
      },
      {
        id: "usage.refresh",
        title: "Usage: refresh now",
        group: "Usage",
        bind: "ctrl+shift+u",
        run: () => props.refresh(),
      },
    ],
  }));

  // ponytail: best-effort in-dialog keys. V2 exposes no documented modal mode
  // name, so r/tab/j bind only if the host names dialog input "modal".
  props.ctx.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: "usage.dialog.refresh", bind: "r", run: () => props.refresh() },
      {
        id: "usage.dialog.scope",
        bind: "tab",
        run: () =>
          props.panel.setScope((n) => (n + 1) % Math.max(1, props.panel.reports().length + 1)),
      },
      { id: "usage.dialog.json", bind: "j", run: () => props.panel.setShowJson((v) => !v) },
    ],
  }));

  return null;
}

function setup(ctx: V2Context): () => void {
  const options = coerceTuiOptions(ctx.options as Record<string, unknown> | undefined);
  const api = createV2Api(ctx);
  const panel = createUsagePanel(() => activeSessionID(api), options);

  const offIdle = ctx.data.on("session.idle", () => panel.refresh());

  const openDialog = (): void => {
    const sessionID = activeSessionID(api);
    void panel.refreshCapture().finally(() => {
      if (panel.isDisposed()) return;
      panel.setScope(0);
      panel.setShowJson(false);
      ctx.ui.dialog.show(() => (
        <UsageDialog
          api={api}
          sessionID={sessionID}
          reports={panel.reports}
          busy={panel.busy}
          error={panel.error}
          now={() => new Date(panel.tick())}
          system={panel.capture}
          scope={panel.scope}
          showJson={panel.showJson}
          barWidth={options.barWidth}
        />
      ));
      ctx.ui.dialog.set({ size: "xlarge" });
    });
  };

  const offSidebar = ctx.ui.slot({
    append: "sidebar.content",
    render: () => (
      <UsageSidebar
        theme={() => asV1Theme(v2ThemeColors(ctx.theme))}
        reports={panel.reports}
        busy={panel.busy}
        error={panel.error}
        tick={panel.tick}
        barWidth={options.barWidth}
      />
    ),
  });

  const offCommands = ctx.ui.slot({
    append: "app",
    render: () => (
      <V2CommandLayer
        ctx={ctx}
        open={openDialog}
        refresh={() => void panel.load(true)}
        panel={panel}
      />
    ),
  });

  void panel.load();

  return () => {
    panel.dispose();
    offIdle();
    offSidebar();
    offCommands();
  };
}

// One default export serves both contracts: V1 reads `tui`, V2 reads `setup`
// and discards the rest (Effect Schema strips undeclared keys).
const plugin: TuiPluginModule & { id: string; setup: (ctx: V2Context) => () => void } = {
  id: "usage-report",
  tui,
  setup,
};

export default plugin;
