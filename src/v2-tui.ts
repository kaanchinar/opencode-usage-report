/**
 * OpenCode 2.x TUI plugin glue.
 *
 * OpenCode 2's TUI host loads the `./tui` entrypoint and validates its default
 * export as `{ id, setup }` — a module whose default lacks `setup` is rejected
 * with "Invalid V2 TUI plugin module". V2 also replaced the old `api.*` surface
 * (snake_case slots, `api.state`, `api.route`, `api.ui.dialog.replace`) with a
 * dot-separated slot tree (`ui.slot`), a client-local store (`data`), and a
 * `ui.dialog` stack. The types here are mirrored structurally from
 * `@opencode/plugin@2.0.20` (`dist/tui/context.d.ts` / `@opencode/theme`) —
 * the host injects the context, so this package must not resolve either
 * package at runtime.
 *
 * Rather than fork every renderer, `createV2Api` adapts the V2 context back to
 * the V1 `TuiPluginApi` shape the existing sidebar/dialog already consume.
 */
import type { Message, Part, Provider, Session } from "@opencode-ai/sdk/v2";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { finiteOrNull, isRecord, safeString } from "./normalize";

type V1ThemeCurrent = TuiPluginApi["theme"]["current"];

// ---------------------------------------------------------------------------
// Structural mirror of the V2 TUI context (subset actually consumed).
// ---------------------------------------------------------------------------

export interface V2ThemeFeedbackColor {
  readonly base?: RGBA;
  readonly muted?: RGBA;
  /** Pre-2.0.8 spelling. */
  readonly default?: RGBA;
}

export interface V2ThemeText {
  readonly base?: RGBA;
  readonly muted?: RGBA;
  /** Pre-2.0.8 spellings. */
  readonly default?: RGBA;
  readonly subdued?: RGBA;
  readonly feedback?: {
    readonly error?: V2ThemeFeedbackColor;
    readonly warning?: V2ThemeFeedbackColor;
    readonly success?: V2ThemeFeedbackColor;
    readonly info?: V2ThemeFeedbackColor;
  };
}

export interface V2Theme {
  readonly text: V2ThemeText;
  readonly border?: { readonly base?: RGBA };
  readonly hue?: {
    readonly accent?: Readonly<Record<number, RGBA>>;
    readonly interactive?: Readonly<Record<number, RGBA>>;
  };
}

export interface V2Route {
  readonly type: string;
  readonly sessionID?: string;
}

export interface V2ModelRef {
  readonly providerID?: string;
  readonly modelID?: string;
}

export interface V2TokenUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cache?: { readonly read?: number; readonly write?: number };
}

export interface V2ToolState {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly time?: { readonly compacted?: number };
}

export interface V2ContentPart {
  readonly type?: string;
  readonly text?: string;
  readonly filename?: string;
  readonly mime?: string;
  readonly state?: V2ToolState;
}

export interface V2AssistantMessage {
  readonly id?: string;
  readonly type: "assistant";
  readonly model?: V2ModelRef;
  readonly content?: readonly V2ContentPart[];
  readonly tokens?: V2TokenUsage;
  readonly time?: { readonly created?: number };
}

export interface V2UserFile {
  readonly filename?: string;
  readonly name?: string;
  readonly mime?: string;
}

export interface V2UserMessage {
  readonly id?: string;
  readonly type: "user";
  readonly text?: string;
  readonly files?: readonly V2UserFile[];
  readonly time?: { readonly created?: number };
}

export interface V2ProviderInfo {
  readonly id: string;
}

export interface V2ModelInfo {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly name: string;
  readonly limit?: { readonly context?: number };
}

export interface V2Data {
  on(type: string, handler: (event: unknown) => void): () => void;
  readonly session: {
    cost(sessionID: string): number;
    readonly message: { list(sessionID: string): readonly unknown[] };
  };
  readonly location: {
    readonly provider: { list(): readonly V2ProviderInfo[] | undefined };
    readonly model: { list(): readonly V2ModelInfo[] | undefined };
  };
}

export interface V2Dialog {
  show(render: () => unknown, onClose?: () => void): void;
  set(options: {
    readonly size?: "medium" | "large" | "xlarge";
    readonly centered?: boolean;
  }): void;
  clear(): void;
}

export interface V2KeymapCommand {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly group?: string;
  readonly palette?: true;
  readonly bind?: false | string;
  readonly slash?: { readonly name: string; readonly aliases?: readonly string[] };
  readonly run: (input?: string, event?: unknown) => void | false | Promise<void>;
}

export interface V2KeymapLayer {
  readonly mode?: string;
  readonly commands?: readonly V2KeymapCommand[];
  readonly bindings?: readonly string[];
}

export interface V2SlotClaim {
  readonly render: (input: never) => unknown;
  readonly append: string;
  readonly prepend?: never;
  readonly before?: never;
  readonly after?: never;
  readonly replace?: never;
}

export interface V2Context {
  readonly options?: Readonly<Record<string, unknown>>;
  readonly theme: V2Theme;
  readonly data: V2Data;
  readonly ui: {
    readonly slot: (claim: V2SlotClaim) => () => void;
    readonly dialog: V2Dialog;
    readonly router: { current(): V2Route };
  };
  readonly keymap: { layer(input: () => V2KeymapLayer): void };
}

// ---------------------------------------------------------------------------
// Theme adapter (V2 tokens -> the V1 names the renderers read).
// ---------------------------------------------------------------------------

/** The V1 theme keys `buildLines` / `buildContextLines` resolve by name. */
export interface UsageThemeColors {
  text: RGBA;
  textMuted: RGBA;
  accent: RGBA;
  secondary: RGBA;
  info: RGBA;
  success: RGBA;
  warning: RGBA;
  error: RGBA;
  borderSubtle: RGBA;
}

function feedbackBase(color: V2ThemeFeedbackColor | undefined, fallback: RGBA): RGBA {
  return color?.base ?? color?.default ?? fallback;
}

/**
 * Maps the V2 resolved theme onto the V1 color names. Reads both the 2.0.8+
 * spelling (`base`/`muted`) and the earlier one (`default`/`subdued`), and
 * falls back to the body text color so a rename upstream paints default
 * foreground instead of nothing.
 */
export function v2ThemeColors(theme: V2Theme): UsageThemeColors {
  const text = theme?.text ?? {};
  const base = (text.base ?? text.default) as RGBA;
  const muted = (text.muted ?? text.subdued) as RGBA;
  const feedback = text.feedback ?? {};
  const accent = (theme?.hue?.accent?.[500] ?? base) as RGBA;
  const secondary = (theme?.hue?.interactive?.[500] ?? muted) as RGBA;
  return {
    text: base,
    textMuted: muted,
    accent,
    secondary,
    info: feedbackBase(feedback.info, base),
    success: feedbackBase(feedback.success, base),
    warning: feedbackBase(feedback.warning, base),
    error: feedbackBase(feedback.error, base),
    borderSubtle: (theme?.border?.base ?? muted) as RGBA,
  };
}

/** Casts the adapter result for the V1-typed renderers. */
export function asV1Theme(colors: UsageThemeColors): V1ThemeCurrent {
  return colors as unknown as V1ThemeCurrent;
}

// ---------------------------------------------------------------------------
// Data adapter (V2 messages -> the V1 message/part shape `collectContext` reads).
// ---------------------------------------------------------------------------

const ZERO_TOKENS = { input: 0, output: 0, cache: { read: 0, write: 0 } };

function createdAt(message: { readonly time?: { readonly created?: number } }): {
  created: number;
} {
  return { created: finiteOrNull(message.time?.created) ?? 0 };
}

/**
 * Translates one V2 message into a V1-shaped record plus its inline parts.
 * V2 assistant content already carries `text`/`reasoning`/`tool` parts; V2 user
 * messages carry a single `text` and an optional file list, so those are
 * synthesized into the same part shape.
 */
function translateMessage(raw: unknown): {
  record: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
} {
  if (!isRecord(raw)) return { record: {}, parts: [] };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (raw.type === "assistant") {
    const message = raw as unknown as V2AssistantMessage;
    const tokens = isRecord(message.tokens) ? message.tokens : {};
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const model = isRecord(message.model) ? message.model : {};
    const parts = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    return {
      record: {
        id,
        role: "assistant",
        providerID: safeString(model.providerID),
        modelID: safeString(model.modelID),
        time: createdAt(message),
        tokens: {
          input: finiteOrNull(tokens.input) ?? 0,
          output: finiteOrNull(tokens.output) ?? 0,
          cache: { read: finiteOrNull(cache.read) ?? 0, write: finiteOrNull(cache.write) ?? 0 },
        },
      },
      parts: parts as Array<Record<string, unknown>>,
    };
  }
  if (raw.type === "user") {
    const message = raw as unknown as V2UserMessage;
    const parts: Array<Record<string, unknown>> = [];
    if (typeof message.text === "string" && message.text !== "") {
      parts.push({ type: "text", text: message.text });
    }
    if (Array.isArray(message.files)) {
      for (const file of message.files) {
        if (!isRecord(file)) continue;
        parts.push({
          type: "file",
          filename: safeString(file.filename ?? file.name),
          mime: safeString(file.mime),
        });
      }
    }
    return {
      record: { id, role: "user", time: createdAt(message), tokens: { ...ZERO_TOKENS } },
      parts,
    };
  }
  return { record: {}, parts: [] };
}

/** Provider list with the `{ id, models }` shape `UsageDialog` looks up. */
export function v2ProviderModels(data: V2Data): Array<{
  id: string;
  models: Record<string, V2ModelInfo>;
}> {
  const byProvider = new Map<string, Record<string, V2ModelInfo>>();
  for (const model of data.location.model.list() ?? []) {
    const bucket = byProvider.get(model.providerID) ?? {};
    bucket[model.modelID] = model;
    byProvider.set(model.providerID, bucket);
  }
  return (data.location.provider.list() ?? []).map((provider) => ({
    id: provider.id,
    models: byProvider.get(provider.id) ?? {},
  }));
}

// ---------------------------------------------------------------------------
// Context -> V1 API facade.
// ---------------------------------------------------------------------------

/**
 * Presents the V2 context through the slice of `TuiPluginApi` the sidebar and
 * `/usage` dialog consume (`theme.current`, `route.current`, `state.*`,
 * `ui.dialog`), so the existing renderers run unchanged.
 *
 * `state.config` is intentionally absent: OpenCode 2 does not expose the
 * resolved config to TUI plugins, so the dialog loses the compaction-reserve
 * nuance only (the token rows are unaffected).
 */
export function createV2Api(ctx: V2Context): TuiPluginApi {
  const partsById = new Map<string, Array<Record<string, unknown>>>();

  const api = {
    theme: {
      get current(): V1ThemeCurrent {
        return asV1Theme(v2ThemeColors(ctx.theme));
      },
    },
    route: {
      get current(): { name: string; params?: Record<string, unknown> } {
        const route = ctx.ui.router.current();
        if (route.type === "session" && typeof route.sessionID === "string") {
          return { name: "session", params: { sessionID: route.sessionID } };
        }
        return { name: route.type };
      },
    },
    state: {
      get provider(): ReadonlyArray<Provider> {
        return v2ProviderModels(ctx.data) as unknown as ReadonlyArray<Provider>;
      },
      get config(): undefined {
        return undefined;
      },
      session: {
        messages(sessionID: string): ReadonlyArray<Message> {
          const list = ctx.data.session.message.list(sessionID) ?? [];
          const messages: Array<Record<string, unknown>> = [];
          partsById.clear();
          for (const raw of list) {
            const { record, parts } = translateMessage(raw);
            if (typeof record.id !== "string" || record.id === "") continue;
            messages.push(record);
            partsById.set(record.id, parts);
          }
          return messages as unknown as ReadonlyArray<Message>;
        },
        get(sessionID: string): Session {
          return { cost: ctx.data.session.cost(sessionID) } as unknown as Session;
        },
      },
      part(messageID: string): ReadonlyArray<Part> {
        return (partsById.get(messageID) ?? []) as unknown as ReadonlyArray<Part>;
      },
    },
    ui: {
      dialog: {
        replace(render: () => unknown, onClose?: () => void): void {
          ctx.ui.dialog.show(render, onClose);
        },
        setSize(size: "medium" | "large" | "xlarge"): void {
          ctx.ui.dialog.set({ size });
        },
        clear(): void {
          ctx.ui.dialog.clear();
        },
      },
    },
  };
  return api as unknown as TuiPluginApi;
}
