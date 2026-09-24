import type { PluginOptions, ProviderAdapter, ProviderReport } from "./types";
import { adapters, getAdapter } from "./providers/index";
import { redact, resolveCredential } from "./auth";
import { ensureSessionId, readCache, writeCache } from "./cache";
import type { CacheEntry } from "./cache";
import { localEstimate } from "./fallback";

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
  explicit: boolean,
): Promise<ProviderReport | null> {
  const cred = resolveCredential(id, { env });
  if (cred === null) {
    // The default view lists only providers that are actually configured; a
    // provider the user asked for by name still reports the missing credential.
    return explicit ? errorReport(id, adapter.displayName, "no credential found") : null;
  }

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
    failure = redact(
      redact(err instanceof Error ? err.message : String(err), cred.key),
      cred.accountId ?? null,
    );
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
 * configured adapter; unconfigured ones are skipped unless requested by name).
 * Never throws: each provider is isolated and failures surface as
 * `source: "error"` rows.
 */
export async function collectReports(opts: CollectReportsOptions = {}): Promise<ProviderReport[]> {
  const options: PluginOptions = { ...DEFAULT_OPTIONS, ...opts.options };
  const env = opts.env ?? process.env;
  const refresh = opts.refresh === true;

  // An empty filter is treated like "no filter": report every registered adapter.
  const requested = firstNonEmpty(opts.providers) ?? firstNonEmpty(options.providers);
  const ids = requested ?? adapters.map((adapter) => adapter.id);
  const explicit = requested !== null;
  const reports: ProviderReport[] = [];

  for (const id of ids) {
    const adapter = getAdapter(id);
    if (adapter === undefined) {
      const known = adapters.map((entry) => entry.id).join(", ");
      reports.push(errorReport(id, id, `unknown provider '${id}' (known: ${known})`));
      continue;
    }

    try {
      const report = await collectOne(id, adapter, options, refresh, env, explicit);
      if (report !== null) reports.push(report);
    } catch {
      // Last-resort isolation: never let one provider break the whole report.
      reports.push(errorReport(id, adapter.displayName, "internal error while collecting usage"));
    }
  }

  return reports;
}
