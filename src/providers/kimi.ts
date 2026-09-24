import type {
  AdapterResult,
  Credential,
  FetchOptions,
  ProviderAdapter,
  UsageWindow,
} from "../types";
import { AdapterError } from "../types";
import { pick, ratioToPercent, toISODate, toNumber, windowFromCounts } from "../normalize";
import { redact } from "../auth";

const VERSION = "0.3.0";

/**
 * Kimi Code is split by region in opencode/models.dev: the global plan lives on
 * api.kimi.ai and the mainland-China plan on api.kimi.com. Both expose the same
 * `GET <base>/usages` contract, so one factory builds both adapters.
 */
export interface KimiAdapterConfig {
  id: string;
  displayName: string;
  /** API base including the version segment, e.g. "https://api.kimi.ai/coding/v1". */
  baseUrl: string;
}

function request(cred: Credential, opts: FetchOptions, endpoint: string): Promise<Response> {
  return fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + cred.key,
      Accept: "application/json",
      "User-Agent": "opencode-usage-report/" + VERSION,
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
}

/** One retry on network throw or 5xx; 4xx and 2xx return immediately. */
async function fetchWithRetry(
  cred: Credential,
  opts: FetchOptions,
  endpoint: string,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await request(cred, opts, endpoint);
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AdapterError("network", redact(`Kimi API network error: ${detail}`, cred.key));
}

function findLimitDetail(limits: unknown, durationMinutes: number): unknown {
  if (!Array.isArray(limits)) return undefined;
  for (const entry of limits) {
    const window = pick(entry, "window");
    const duration = toNumber(pick(window, "duration"));
    const unit = pick(window, "timeUnit", "time_unit");
    if (duration === durationMinutes && unit === "TIME_UNIT_MINUTE") {
      return pick(entry, "detail");
    }
  }
  return undefined;
}

function ratioWindow(kind: UsageWindow["kind"], label: string, value: unknown): UsageWindow {
  const ratio = toNumber(pick(value, "used_ratio", "usedRatio"));
  return {
    kind,
    label,
    usedPercent: ratio !== null ? ratioToPercent(ratio) : null,
    used: null,
    limit: null,
    remaining: null,
    resetsAt: toISODate(pick(value, "reset_time", "resetTime", "resetAt", "resetsAt")),
    status: "ok",
  };
}

function detailWindow(kind: UsageWindow["kind"], label: string, detail: unknown): UsageWindow {
  return windowFromCounts(kind, label, {
    limit: pick(detail, "limit"),
    used: pick(detail, "used"),
    remaining: pick(detail, "remaining"),
    reset: pick(detail, "resetTime", "reset_time", "resetAt", "resetsAt"),
  });
}

function parse(body: Record<string, unknown>, cred: Credential): AdapterResult {
  const windows: UsageWindow[] = [];
  const extras: Record<string, string> = {};

  const usages = pick(body, "usages");
  const usage = pick(body, "usage");
  const limits = pick(body, "limits");

  // Count-based windows are authoritative; the `usages.limit_5h/limit_7d`
  // ratios are legacy fields the live API returns as stale zeros even while
  // real usage accrues, so they are only a fallback when counts are missing.
  const detail5h = findLimitDetail(limits, 300);
  if (detail5h !== undefined) {
    windows.push(detailWindow("5h", "5-hour", detail5h));
  } else {
    const limit5h = pick(usages, "limit_5h");
    if (limit5h !== undefined) windows.push(ratioWindow("5h", "5-hour", limit5h));
  }

  if (usage !== undefined) {
    windows.push(detailWindow("weekly", "Weekly", usage));
  } else {
    const limit7d = pick(usages, "limit_7d");
    if (limit7d !== undefined) windows.push(ratioWindow("weekly", "Weekly", limit7d));
  }

  const level = pick(pick(body, "user"), "membership");
  const membershipLevel = pick(level, "level");
  if (membershipLevel !== undefined) extras["Plan"] = String(membershipLevel);

  const wallet = pick(body, "booster_wallet");

  // `balance` is a wallet descriptor object on the live API; only render scalar values.
  const balance = pick(wallet, "balance");
  if (typeof balance === "string" || typeof balance === "number") {
    extras["Booster wallet"] = String(balance);
  }

  const monthlyUsed = pick(wallet, "monthlyUsed", "monthly_used");
  const currency = pick(monthlyUsed, "currency");
  const priceInCents = toNumber(pick(monthlyUsed, "priceInCents", "price_in_cents"));
  if (
    (typeof currency === "string" || typeof currency === "number") &&
    String(currency) !== "" &&
    priceInCents !== null
  ) {
    extras["Booster used this month"] = `$${(priceInCents / 100).toFixed(2)} ${String(currency)}`;
  }

  const totalQuota = pick(body, "totalQuota", "total_quota");
  const quotaUsed = toNumber(pick(totalQuota, "used"));
  if (totalQuota !== undefined && quotaUsed !== null && quotaUsed > 0) {
    windows.push({
      kind: "monthly",
      label: "Monthly",
      usedPercent: null,
      used: quotaUsed,
      limit: toNumber(pick(totalQuota, "limit")),
      remaining: toNumber(pick(totalQuota, "remaining")),
      resetsAt: toISODate(pick(totalQuota, "resetTime", "reset_time", "resetAt", "resetsAt")),
      status: "frozen",
    });
  }

  if (windows.length === 0) {
    throw new AdapterError(
      "bad-response",
      redact("Kimi API response contained no usage windows", cred.key),
    );
  }

  return { windows, extras };
}

export function createKimiAdapter(config: KimiAdapterConfig): ProviderAdapter {
  const endpoint = `${config.baseUrl}/usages`;
  return {
    id: config.id,
    displayName: config.displayName,
    async fetch(cred: Credential, opts: FetchOptions): Promise<AdapterResult> {
      const res = await fetchWithRetry(cred, opts, endpoint);

      if (res.status === 401) {
        throw new AdapterError("auth", redact("invalid Kimi API key", cred.key));
      }
      if (res.status === 429) {
        throw new AdapterError("rate-limited", redact("Kimi API rate limit exceeded", cred.key));
      }
      if (res.status < 200 || res.status >= 300) {
        throw new AdapterError(
          "bad-response",
          redact(`Kimi API returned HTTP ${res.status}`, cred.key),
        );
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AdapterError(
          "bad-response",
          redact("Kimi API returned a non-JSON response", cred.key),
        );
      }

      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new AdapterError(
          "bad-response",
          redact("Kimi API returned an unexpected response shape", cred.key),
        );
      }

      return parse(body as Record<string, unknown>, cred);
    },
  };
}

/** Kimi For Coding (kimi.ai) — the global `kimi-code-plan-global` provider. */
export const kimiGlobalAdapter: ProviderAdapter = createKimiAdapter({
  id: "kimi-code-plan-global",
  displayName: "Kimi Code (kimi.ai)",
  baseUrl: "https://api.kimi.ai/coding/v1",
});

/** Kimi For Coding (kimi.com) — the mainland-China `kimi-code-plan-cn` provider. */
export const kimiCnAdapter: ProviderAdapter = createKimiAdapter({
  id: "kimi-code-plan-cn",
  displayName: "Kimi Code (kimi.com)",
  baseUrl: "https://api.kimi.com/coding/v1",
});
