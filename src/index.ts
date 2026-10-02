import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS, collectReports } from "./report";
import { renderJson, renderText } from "./render";
import { checkWarnings } from "./warn";
import { toNumber } from "./normalize";
import { adapters } from "./providers/index";
import { estimateTokens } from "./context/estimate";
import { writeCapture } from "./context/system";
import type { PluginOptions } from "./types";

const WARN_THROTTLE_MS = 10 * 60 * 1000;

const TOOL_DESCRIPTION =
  "Show subscription usage/quota windows (5h, weekly, monthly) for configured inference providers " +
  `(${adapters.map((adapter) => adapter.id).join(", ")})`;

/** Merges user plugin options over defaults, defensively ignoring malformed values. */
export function coerceOptions(raw: Record<string, unknown> | undefined): PluginOptions {
  const opts: PluginOptions = { ...DEFAULT_OPTIONS };
  if (raw === undefined) return opts;

  const threshold = toNumber(raw.thresholdPercent);
  if (threshold !== null) opts.thresholdPercent = threshold;

  const ttl = toNumber(raw.cacheTtlSeconds);
  if (ttl !== null) opts.cacheTtlSeconds = ttl;

  if (typeof raw.fallback === "boolean") opts.fallback = raw.fallback;

  if (Array.isArray(raw.providers)) {
    const ids = raw.providers.filter((id): id is string => typeof id === "string");
    // An empty filter means "all providers", matching `undefined`/`null`.
    opts.providers = ids.length > 0 ? ids : null;
  } else if (raw.providers === null) {
    opts.providers = null;
  }

  return opts;
}

/**
 * Throttled warning pass shared by the V1 and V2 plugin APIs (spec §3.6/§3.7).
 * Every failure is swallowed (spec §4): it must never throw into the event bus.
 */
function makeWarnRunner(
  opts: PluginOptions,
  notify: (message: string) => Promise<unknown> | unknown,
): () => Promise<void> {
  let lastWarnCheck = 0;
  return async (): Promise<void> => {
    try {
      if (Date.now() - lastWarnCheck < WARN_THROTTLE_MS) return;
      lastWarnCheck = Date.now();

      const reports = await collectReports({ options: opts });
      const hits = await checkWarnings(reports, opts.thresholdPercent);
      for (const hit of hits) {
        try {
          await notify(hit.message);
        } catch {
          // Toast delivery is best-effort; it is unavailable in headless/server mode.
        }
      }
    } catch {
      // Never throw into the event bus.
    }
  };
}

async function runUsageReport(
  args: Record<string, unknown> | undefined,
  opts: PluginOptions,
): Promise<{ content: string }> {
  const reports = await collectReports({
    providers: args?.provider ? [String(args.provider)] : undefined,
    refresh: args?.refresh === true,
    options: opts,
  });
  return { content: args?.json === true ? renderJson(reports) : renderText(reports) };
}

const TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    provider: { type: "string" },
    json: { type: "boolean" },
    refresh: { type: "boolean" },
  },
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// OpenCode 2.x (V2) plugin API.
//
// The harness decodes the module's default export against `{ id, setup }` or
// `{ id, effect }` and otherwise fails with "Plugin must export a default
// definition with an id and an effect or setup function" (err_b890e30e). The
// context types are declared locally so the package needs no runtime dependency
// on the V2 SDK; opencode erases `import type` anyway.
// ---------------------------------------------------------------------------

interface V2ToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (args: Record<string, unknown> | undefined) => Promise<{ content: string }>;
}

interface V2ToolEditor {
  add(definition: V2ToolDefinition): void;
}

interface V2ContextEvent {
  sessionID?: string;
  model?: { providerID?: string; id?: string };
  system?: Array<{ type?: string; text?: string } | string>;
}

interface V2PluginContext {
  options?: Record<string, unknown>;
  tool: { transform: (callback: (editor: V2ToolEditor) => void) => Promise<unknown> };
  session: {
    hook: (name: "context", handler: (event: V2ContextEvent) => unknown) => Promise<unknown>;
  };
  event: { subscribe: (options: { signal: AbortSignal }) => AsyncIterable<{ type?: string }> };
  /** Not part of the V2 server context; present only if the runtime exposes it. */
  tui?: { showToast?: (input: unknown) => Promise<unknown> };
}

/** Joins V2 system parts (text parts plus plain strings) into one prompt string. */
function joinSystem(event: V2ContextEvent | undefined): string {
  if (!Array.isArray(event?.system)) return "";
  return event.system
    .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
    .join("\n");
}

/** Best-effort capture of the assembled system prompt size (spec §9.1). */
async function captureSystemFromContext(event: V2ContextEvent | undefined): Promise<void> {
  try {
    const sessionID = event?.sessionID;
    const model = event?.model;
    if (typeof sessionID !== "string" || sessionID === "") return;
    if (
      model === undefined ||
      typeof model.providerID !== "string" ||
      typeof model.id !== "string"
    ) {
      return;
    }

    const system = joinSystem(event);
    if (system === "") return;

    await writeCapture({
      version: 1,
      sessionID,
      providerID: model.providerID,
      modelID: model.id,
      systemChars: system.length,
      systemTokens: estimateTokens(system),
      capturedAt: Date.now(),
    });
  } catch {
    // Best-effort: an experimental hook must never be able to break a request.
  }
}

async function setup(ctx: V2PluginContext): Promise<() => void> {
  const opts = coerceOptions(ctx?.options);

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "usage_report",
      description: TOOL_DESCRIPTION,
      input: TOOL_INPUT_SCHEMA,
      execute: (args) => runUsageReport(args, opts),
    });
  });

  await ctx.session.hook("context", (event) => captureSystemFromContext(event));

  const runWarnCheck = makeWarnRunner(opts, (message) => {
    const showToast = ctx.tui?.showToast;
    if (typeof showToast !== "function") return;
    return showToast({ body: { title: "Usage warning", message, variant: "warning" } });
  });

  // Spec §3.6: one throttled warning check at startup, fire-and-forget.
  setTimeout(() => {
    void runWarnCheck();
  }, 0);

  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event?.type === "session.idle") await runWarnCheck();
      }
    } catch {
      // Subscription aborted on unload, or the event transport failed.
    }
  })();

  return () => controller.abort();
}

// ---------------------------------------------------------------------------
// OpenCode 1.x (V1) plugin API. Kept from the previous release so packages can
// serve both APIs during the V2 migration; V2 calls `setup`, V1 calls `server`.
// ---------------------------------------------------------------------------

async function server({ client }: PluginInput, options?: Record<string, unknown>): Promise<Hooks> {
  const opts = coerceOptions(options);

  const runWarnCheck = makeWarnRunner(opts, (message) =>
    client.tui.showToast({
      body: { title: "Usage warning", message, variant: "warning" },
    }),
  );

  // Spec §3.6: one throttled warning check at startup, fire-and-forget.
  setTimeout(() => {
    void runWarnCheck();
  }, 0);

  return {
    tool: {
      usage_report: tool({
        description: TOOL_DESCRIPTION,
        args: {
          provider: tool.schema.string().optional(),
          json: tool.schema.boolean().optional(),
          refresh: tool.schema.boolean().optional(),
        },
        async execute(args) {
          return (await runUsageReport(args, opts)).content;
        },
      }),
    },

    // `/usage` is owned by the TUI plugin so the slash command opens a local
    // dialog instead of routing through the model. This hook's only job is to
    // measure the assembled system prompt, which opencode never persists, so
    // the TUI can split the "System & tools" residual (spec §9.1).
    async "experimental.chat.system.transform"(input, output) {
      try {
        const sessionID = input?.sessionID;
        if (typeof sessionID !== "string" || sessionID === "") return;
        const model = input?.model;
        if (model === undefined) return;
        const system = Array.isArray(output?.system) ? output.system.join("\n") : "";
        if (system === "") return;

        await writeCapture({
          version: 1,
          sessionID,
          providerID: model.providerID,
          modelID: model.id,
          systemChars: system.length,
          systemTokens: estimateTokens(system),
          capturedAt: Date.now(),
        });
      } catch {
        // Best-effort: an experimental hook must never be able to break a request.
      }
    },

    async event({ event }) {
      try {
        if (event.type !== "session.idle") return;
        await runWarnCheck();
      } catch {
        // Never throw into the event bus.
      }
    },
  };
}

const definition = {
  id: "opencode-usage-report",
  setup,
  server,
};

export default definition;
