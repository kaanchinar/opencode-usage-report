import type {
  AdapterResult,
  Credential,
  FetchOptions,
  ProviderAdapter,
  UsageWindow,
  WindowKind,
  WindowStatus,
} from "../types";
import { AdapterError } from "../types";
import { toISODate, toNumber } from "../normalize";
import { redact } from "../auth";
import { asRecord, handleError, readBody, request } from "./http";

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

export const opencodeGoAdapter: ProviderAdapter = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  async fetch(cred: Credential, opts: OpenCodeGoFetchOptions): Promise<AdapterResult> {
    const res = await request(cred, opts, {
      endpoint: ENDPOINT,
      label: "OpenCode Go request failed",
      headers: { "x-opencode-session": opts.sessionId ?? "unknown" },
    });

    if (!res.ok) {
      return handleError(res, cred, (status, { text, json }) => {
        if (status === 401) return { kind: "auth", message: "invalid OpenCode Go API key" };
        if (status === 403) {
          const record = asRecord(json);
          const error = record ? asRecord(record.error) : null;
          if (error && error.type === "EntitlementError") {
            return {
              kind: "no-plan",
              message: "OpenCode Go subscription not active on this key",
            };
          }
          return { kind: "network", message: "OpenCode Go request blocked (check User-Agent)" };
        }
        if (status === 429) {
          return { kind: "rate-limited", message: "OpenCode Go rate limit reached" };
        }
        if (status >= 500) {
          return { kind: "network", message: `OpenCode Go server error ${status}` };
        }
        return {
          kind: "bad-response",
          message: `OpenCode Go unexpected status ${status}: ${text.slice(0, 200)}`,
        };
      });
    }

    const { json } = await readBody(res);
    const body = asRecord(json);
    const usage = body ? asRecord(body.usage) : null;
    if (!usage) {
      throw new AdapterError(
        "bad-response",
        redact("OpenCode Go response missing usage", cred.key),
      );
    }

    const windows: UsageWindow[] = [];
    for (const { key, kind, label } of WINDOWS) {
      const window = buildWindow(kind, label, usage[key]);
      if (window) windows.push(window);
    }

    return { windows };
  },
};
