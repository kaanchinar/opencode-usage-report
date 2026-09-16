import type { PluginOptions, ProviderAdapter, ProviderReport } from "./types.js";
import { adapters, getAdapter } from "./providers/index.js";
import { redact, resolveCredential } from "./auth.js";
import { ensureSessionId, readCache, writeCache } from "./cache.js";
import type { CacheEntry } from "./cache.js";
import { localEstimate } from "./fallback.js";

export const DEFAULT_OPTIONS: PluginOptions = {
  thresholdPercent: 80,
  cacheTtlSeconds: 120,
  providers: null,
  fallback: true,
};

const FETCH_TIMEOUT_MS = 5000;

export interface CollectReportsOptions {
  providers?: string[];
  refresh?: boolean;
  options?: Partial<PluginOptions>;
  env?: NodeJS.ProcessEnv;
}

/** Normalizes a provider filter: null/undefined/empty all mean "all providers". */
function firstNonEmpty(list: string[] | null | undefined): string[] | null {
  return Array.isArray(list) && list.length > 0 ? list : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorReport(provider: string, displayName: string, error: string): ProviderReport {
  return {
    provider,
    displayName,
    fetchedAt: nowIso(),
    source: "error",
    stale: false,
    windows: [],
    extras: {},
    error,
  };
}

function cacheReport(
  provider: string,
  displayName: string,
  entry: CacheEntry,
  stale: boolean,
  error: string | null,
): ProviderReport {
  return {
    provider,
    displayName,
    fetchedAt: entry.fetchedAt,
    source: "cache",
    stale,
    windows: entry.result.windows,
    extras: entry.result.extras ?? {},
    error,
  };
}

/** Collects one provider: credential -> fresh cache -> live fetch -> stale cache -> local estimate. */
async function collectOne(
  id: string,
  adapter: ProviderAdapter,
  options: PluginOptions,
  refresh: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ProviderReport> {
  const cred = resolveCredential(id, { env });
  if (cred === null) return errorReport(id, adapter.displayName, "no credential found");

  if (!refresh) {
    const cached = await readCache(id, options.cacheTtlSeconds, env);
    if (cached !== null && cached.fresh) {
      return cacheReport(id, adapter.displayName, cached.entry, false, null);
    }
  }

  let failure: string;
  try {
    const sessionId = await ensureSessionId(env);
    const fetchOptions = { timeoutMs: FETCH_TIMEOUT_MS, sessionId };
    const result = await adapter.fetch(cred, fetchOptions);
    await writeCache(id, result, env);
    return {
      provider: id,
      displayName: adapter.displayName,
      fetchedAt: nowIso(),
      source: "api",
      stale: false,
      windows: result.windows,
      extras: result.extras ?? {},
      error: null,
    };
  } catch (err) {
    failure = redact(err instanceof Error ? err.message : String(err), cred.key);
  }

  const cached = await readCache(id, options.cacheTtlSeconds, env);
  if (cached !== null) {
    return cacheReport(id, adapter.displayName, cached.entry, true, failure);
  }

  if (options.fallback) {
    const estimate = await localEstimate(id, env);
    if (estimate !== null) {
      return {
        provider: id,
        displayName: adapter.displayName,
        fetchedAt: nowIso(),
        source: "local-estimate",
        stale: true,
        windows: estimate.windows,
        extras: estimate.extras ?? {},
        error: failure,
      };
    }
  }

  return errorReport(id, adapter.displayName, failure);
}

/**
 * Collects normalized usage reports for the requested providers (default: every
 * registered adapter). Never throws: each provider is isolated and failures
 * surface as `source: "error"` rows.
 */
export async function collectReports(opts: CollectReportsOptions = {}): Promise<ProviderReport[]> {
  const options: PluginOptions = { ...DEFAULT_OPTIONS, ...(opts.options ?? {}) };
  const env = opts.env ?? process.env;
  const refresh = opts.refresh === true;

  // An empty filter is treated like "no filter": report every registered adapter.
  const ids =
    firstNonEmpty(opts.providers) ??
    firstNonEmpty(options.providers) ??
    adapters.map((adapter) => adapter.id);
  const reports: ProviderReport[] = [];

  for (const id of ids) {
    const adapter = getAdapter(id);
    if (adapter === undefined) {
      const known = adapters.map((entry) => entry.id).join(", ");
      reports.push(errorReport(id, id, `unknown provider '${id}' (known: ${known})`));
      continue;
    }

    try {
      reports.push(await collectOne(id, adapter, options, refresh, env));
    } catch {
      // Last-resort isolation: never let one provider break the whole report.
      reports.push(errorReport(id, adapter.displayName, "internal error while collecting usage"));
    }
  }

  return reports;
}
