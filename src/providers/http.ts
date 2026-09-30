/**
 * Shared HTTP plumbing for provider adapters. Every adapter performs the same
 * authenticated GET with one retry, so the fetch, body-reading and error-mapping
 * helpers live here instead of being copy-pasted per provider.
 */
import type { AdapterErrorKind, Credential, FetchOptions } from "../types";
import { AdapterError } from "../types";
import { redact } from "../auth";

/** Sent as the User-Agent on every provider request; keep in sync with package.json. */
export const USER_AGENT = "opencode-usage-report/0.4.1";

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export interface Body {
  text: string;
  json: unknown;
}

/** Reads the body once as text and best-effort parses JSON, so error and success paths share it. */
export async function readBody(res: Response): Promise<Body> {
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

export interface RequestSpec {
  endpoint: string;
  /** Prefix of the thrown network error, e.g. "Kimi API network error". */
  label: string;
  headers?: Record<string, string>;
}

function attempt(cred: Credential, opts: FetchOptions, spec: RequestSpec): Promise<Response> {
  return fetch(spec.endpoint, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + cred.key,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...spec.headers,
    },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
}

/** Exactly one retry on a network throw or 5xx; 4xx is returned immediately (never retried). */
export async function request(
  cred: Credential,
  opts: FetchOptions,
  spec: RequestSpec,
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await attempt(cred, opts, spec);
      if (res.status >= 500 && i === 0) continue;
      return res;
    } catch (err) {
      lastError = err;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new AdapterError("network", redact(`${spec.label}: ${detail}`, cred.key));
}

export interface ErrorResolution {
  kind: AdapterErrorKind;
  message: string;
}

/** Reads the error body, asks the adapter to map it, and throws the resulting AdapterError. */
export async function handleError(
  res: Response,
  cred: Credential,
  resolve: (status: number, body: Body) => ErrorResolution,
): Promise<never> {
  const body = await readBody(res);
  const { kind, message } = resolve(res.status, body);
  throw new AdapterError(kind, redact(message, cred.key));
}
