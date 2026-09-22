import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { DEFAULT_OPTIONS, collectReports } from "./report.js";
import { renderJson, renderText } from "./render.js";
import { checkWarnings } from "./warn.js";
import { toNumber } from "./normalize.js";
import { adapters } from "./providers/index.js";
import type { PluginOptions } from "./types.js";

const WARN_THROTTLE_MS = 10 * 60 * 1000;

const TOOL_DESCRIPTION =
  "Show subscription usage/quota windows (5h, weekly, monthly) for configured inference providers " +
  `(${adapters.map((adapter) => adapter.id).join(", ")})`;

const COMMAND_TEMPLATE =
  "Call the usage_report tool with these arguments: $ARGUMENTS and present the result verbatim.";

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

const plugin: Plugin = async ({ client }, options) => {
  const opts = coerceOptions(options);
  let lastWarnCheck = 0;

  /** Throttled warning pass (spec §3.7). Every failure is swallowed (spec §4). */
  const runWarnCheck = async (): Promise<void> => {
    try {
      if (Date.now() - lastWarnCheck < WARN_THROTTLE_MS) return;
      lastWarnCheck = Date.now();

      const reports = await collectReports({ options: opts });
      const hits = await checkWarnings(reports, opts.thresholdPercent);
      for (const hit of hits) {
        try {
          await client.tui.showToast({
            body: { title: "Usage warning", message: hit.message, variant: "warning" },
          });
        } catch {
          // Toast delivery is best-effort; it is unavailable in headless/server mode.
        }
      }
    } catch {
      // Never throw into the event bus.
    }
  };

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
          const reports = await collectReports({
            providers: args.provider ? [args.provider] : undefined,
            refresh: args.refresh === true,
            options: opts,
          });
          return args.json ? renderJson(reports) : renderText(reports);
        },
      }),
    },

    async config(cfg) {
      cfg.command ??= {};
      cfg.command.usage ??= {
        description: "Show subscription usage/quota windows for configured providers",
        template: COMMAND_TEMPLATE,
      };
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
};

export default plugin;
