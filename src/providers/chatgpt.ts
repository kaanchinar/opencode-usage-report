import type {
  AdapterResult,
  Credential,
  FetchOptions,
  ProviderAdapter,
  UsageWindow,
  WindowKind,
} from "../types";
import { AdapterError } from "../types";
import { toISODate, toNumber } from "../normalize";
import { redact } from "../auth";
import { asRecord, handleError, readBody, request } from "./http";

const ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

/** "foo_bar-baz" -> "Foo Bar Baz". */
function titleCase(v: string): string {
  return v
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Maps a ChatGPT plan string to a friendly label. Pure so it can be unit-tested directly. */
export function chatgptPlan(plan: unknown): string {
  if (typeof plan === "string" && plan.trim() !== "") {
    const p = plan.toLowerCase();
    if (p === "free") return "ChatGPT Free";
    if (p === "go") return "ChatGPT Go";
    if (p === "plus") return "ChatGPT Plus";
    if (p === "pro") return "ChatGPT Pro";
    if (p === "team") return "ChatGPT Team";
    if (p === "business") return "ChatGPT Business";
    if (p === "enterprise") return "ChatGPT Enterprise";
    return titleCase(plan);
  }
  return "ChatGPT";
}

/** Maps a window length (seconds) to its kind and label. */
function windowKind(seconds: number | null): { kind: WindowKind; label: string } {
  if (seconds === 18000) return { kind: "5h", label: "5-hour" };
  if (seconds === 86400) return { kind: "daily", label: "Daily" };
  if (seconds === 604800) return { kind: "weekly", label: "Weekly" };
  if (seconds === 2592000) return { kind: "monthly", label: "Monthly" };
  return { kind: "other", label: "Other" };
}

export const chatgptAdapter: ProviderAdapter = {
  id: "openai",
  displayName: "ChatGPT",
  async fetch(cred: Credential, opts: FetchOptions): Promise<AdapterResult> {
    if (typeof cred.accountId !== "string" || cred.accountId === "") {
      throw new AdapterError("auth", "ChatGPT account id missing (re-run: opencode auth login)");
    }

    const res = await request(cred, opts, {
      endpoint: ENDPOINT,
      label: "ChatGPT request failed",
      headers: { "ChatGPT-Account-Id": cred.accountId },
    });
    if (!res.ok) {
      return handleError(res, cred, (status, { text }) => {
        if (status === 401) return { kind: "auth", message: "invalid ChatGPT login" };
        if (status === 403) {
          return { kind: "no-plan", message: "ChatGPT is not enabled for this account" };
        }
        if (status === 429) {
          return { kind: "rate-limited", message: "ChatGPT rate limit reached" };
        }
        if (status >= 500) {
          return { kind: "network", message: `ChatGPT server error ${status}` };
        }
        return {
          kind: "bad-response",
          message: `ChatGPT unexpected status ${status}: ${text.slice(0, 200)}`,
        };
      });
    }

    const { json } = await readBody(res);
    const body = asRecord(json);
    const rateLimit = body ? asRecord(body.rate_limit) : null;
    if (!rateLimit) {
      throw new AdapterError(
        "bad-response",
        redact("ChatGPT response missing rate_limit", cred.key),
      );
    }

    const limitReached = rateLimit.limit_reached === true || rateLimit.allowed === false;
    const windows: UsageWindow[] = [];
    for (const raw of [rateLimit.primary_window, rateLimit.secondary_window]) {
      const window = asRecord(raw);
      if (!window) continue;
      const { kind, label } = windowKind(toNumber(window.limit_window_seconds));
      const used = toNumber(window.used_percent);
      windows.push({
        kind,
        label,
        usedPercent: used !== null ? Math.min(100, Math.max(0, Math.round(used * 10) / 10)) : null,
        used: null,
        limit: null,
        remaining: null,
        resetsAt: toISODate(window.reset_at),
        status: limitReached ? "rate-limited" : "ok",
      });
    }

    if (windows.length === 0) {
      throw new AdapterError(
        "bad-response",
        redact("ChatGPT response missing usage windows", cred.key),
      );
    }

    const extras: Record<string, string> = {};
    extras["Plan"] = chatgptPlan(body?.plan_type);

    const credits = body ? asRecord(body.credits) : null;
    if (credits) {
      if (credits.unlimited === true) {
        extras["Credits"] = "unlimited";
      } else {
        const balance = toNumber(credits.balance);
        if (balance !== null) {
          extras["Credits"] = `$${balance.toFixed(2)}`;
        } else if (
          credits.has_credits === true &&
          (credits.balance === null || credits.balance === undefined)
        ) {
          extras["Credits"] = "available";
        }
      }
    }

    return { windows, extras };
  },
};
