import type {
  AdapterResult,
  Credential,
  FetchOptions,
  ProviderAdapter,
  UsageWindow,
  WindowKind,
  WindowStatus,
} from "../types.js";
import { AdapterError } from "../types.js";
import { toISODate, toNumber } from "../normalize.js";
import { redact } from "../auth.js";

const VERSION = "0.1.0";
const USER_AGENT = "opencode-usage-report/" + VERSION;
const ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

/** Additive options: `sessionId` is optional, so the adapter still satisfies `ProviderAdapter`. */
export type OpenCodeGoFetchOptions = FetchOptions & { sessionId?: string };

const WINDOWS: Array<{ key: string; kind: WindowKind; label: string }> = [
  { key: "rolling", kind: "5h", label: "5-hour" },
  { key: "weekly", kind: "weekly", label: "Weekly" },
  { key: "monthly", kind: "monthly", label: "Monthly" },
];

function mapStatus(v: unknown): WindowStatus {
  return v === "ok" || v === "rate-limited" ? v : "unknown";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function buildWindow(kind: WindowKind, label: string, src: unknown): UsageWindow | null {
  const record = asRecord(src);
  if (!record) return null;
  return {
    kind,
    label,
    usedPercent: toNumber(record.percent),
    used: null,
    limit: null,
    remaining: null,
    resetsAt: toISODate(record.resetsAt),
    status: mapStatus(record.status),
  };
}

/** Reads the body once as text and best-effort parses JSON, so error and success paths share it. */
async function readBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

async function attempt(cred: Credential, opts: OpenCodeGoFetchOptions): Promise<Response> {
  return fetch(ENDPOINT, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + cred.key,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "x-opencode-session": opts.sessionId ?? "unknown",
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
}

/** Exactly one retry on a network throw or 5xx; 4xx is returned immediately (never retried). */
async function request(cred: Credential, opts: OpenCodeGoFetchOptions): Promise<Response> {
  try {
    const first = await attempt(cred, opts);
    if (first.status < 500) return first;
  } catch {
    // fall through to the single retry
  }

  try {
    return await attempt(cred, opts);
  } catch (err) {
    throw new AdapterError(
      "network",
      redact(
        `OpenCode Go request failed: ${err instanceof Error ? err.message : String(err)}`,
        cred.key,
      ),
    );
  }
}

async function handleError(res: Response, cred: Credential): Promise<never> {
  const { text, json } = await readBody(res);

  if (res.status === 401) {
    throw new AdapterError("auth", redact("invalid OpenCode Go API key", cred.key));
  }
  if (res.status === 403) {
    const record = asRecord(json);
    const error = record ? asRecord(record.error) : null;
    if (error && error.type === "EntitlementError") {
      throw new AdapterError(
        "no-plan",
        redact("OpenCode Go subscription not active on this key", cred.key),
      );
    }
    throw new AdapterError(
      "network",
      redact("OpenCode Go request blocked (check User-Agent)", cred.key),
    );
  }
  if (res.status === 429) {
    throw new AdapterError("rate-limited", redact("OpenCode Go rate limit reached", cred.key));
  }
  if (res.status >= 500) {
    throw new AdapterError("network", redact(`OpenCode Go server error ${res.status}`, cred.key));
  }
  throw new AdapterError(
    "bad-response",
    redact(`OpenCode Go unexpected status ${res.status}: ${text.slice(0, 200)}`, cred.key),
  );
}

export const opencodeGoAdapter: ProviderAdapter = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  async fetch(cred: Credential, opts: OpenCodeGoFetchOptions): Promise<AdapterResult> {
    const res = await request(cred, opts);
    if (!res.ok) return handleError(res, cred);

    const { json } = await readBody(res);
    const body = asRecord(json);
    const usage = body ? asRecord(body.usage) : null;
    if (!usage) {
      throw new AdapterError("bad-response", redact("OpenCode Go response missing usage", cred.key));
    }

    const windows: UsageWindow[] = [];
    for (const { key, kind, label } of WINDOWS) {
      const window = buildWindow(kind, label, usage[key]);
      if (window) windows.push(window);
    }

    return { windows };
  },
};
