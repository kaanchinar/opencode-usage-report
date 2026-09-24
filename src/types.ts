export type WindowKind = "5h" | "daily" | "weekly" | "monthly" | "other";
export type WindowStatus = "ok" | "rate-limited" | "frozen" | "unknown";

export interface UsageWindow {
  kind: WindowKind;
  label: string; // "5-hour", "Weekly", "Monthly"
  usedPercent: number | null; // 0-100
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null; // ISO-8601
  status: WindowStatus;
}

export type ReportSource = "api" | "cache" | "local-estimate" | "error";

export interface ProviderReport {
  provider: string;
  displayName: string;
  fetchedAt: string;
  source: ReportSource;
  stale: boolean;
  windows: UsageWindow[];
  extras: Record<string, string>;
  error: string | null;
}

export interface Credential {
  type: "api" | "oauth";
  key: string;
  /** Provider account id, when the auth entry carries one (e.g. ChatGPT). */
  accountId?: string;
}
export interface AdapterResult {
  windows: UsageWindow[];
  extras?: Record<string, string>;
}
export interface FetchOptions {
  timeoutMs: number;
}
export interface ProviderAdapter {
  id: string;
  displayName: string;
  fetch(cred: Credential, opts: FetchOptions): Promise<AdapterResult>;
}
export interface PluginOptions {
  thresholdPercent: number; // default 80
  cacheTtlSeconds: number; // default 120
  providers: string[] | null; // null = all discovered
  fallback: boolean; // default true
}

export type AdapterErrorKind = "auth" | "no-plan" | "rate-limited" | "network" | "bad-response";
export class AdapterError extends Error {
  constructor(
    public kind: AdapterErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}
