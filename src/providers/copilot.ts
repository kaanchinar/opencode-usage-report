import type {
  AdapterResult,
  Credential,
  FetchOptions,
  ProviderAdapter,
  UsageWindow,
} from "../types";
import { AdapterError } from "../types";
import { toISODate, toNumber } from "../normalize";
import { redact } from "../auth";
import { asRecord, handleError, readBody, request } from "./http";

const ENDPOINT = "https://api.github.com/copilot_internal/user";

/** Snapshot keys in display order, paired with their human-readable labels. */
const SNAPSHOTS: Array<{ key: string; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "completions", label: "Completions" },
  { key: "premium_interactions", label: "Premium interactions" },
];

/** "foo_bar-baz" -> "Foo Bar Baz". */
function titleCase(v: string): string {
  return v
    .split(/[\s_-]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Maps a Copilot SKU (preferred) or plan string to a friendly tier label.
 * Pure so it can be unit-tested directly.
 */
export function copilotTier(sku: unknown, plan: unknown): string {
  if (typeof sku === "string") {
    const s = sku.toLowerCase();
    if (s === "free_educational_quota") return "Copilot Student";
    if (s === "free" || s.startsWith("free")) return "Copilot Free";
    if (s.includes("pro_plus") || s.includes("pro+")) return "Copilot Pro+";
    if (s.includes("max")) return "Copilot Max";
    if (s.includes("business")) return "Copilot Business";
    if (s.includes("enterprise")) return "Copilot Enterprise";
    if (s.includes("pro")) return "Copilot Pro";
  }
  if (typeof plan === "string" && plan.trim() !== "") {
    const p = plan.toLowerCase();
    if (p === "individual") return "Copilot Individual";
    if (p === "business") return "Copilot Business";
    if (p === "enterprise") return "Copilot Enterprise";
    return titleCase(plan);
  }
  return "Copilot";
}

export const copilotAdapter: ProviderAdapter = {
  id: "github-copilot",
  displayName: "GitHub Copilot",
  async fetch(cred: Credential, opts: FetchOptions): Promise<AdapterResult> {
    const res = await request(cred, opts, {
      endpoint: ENDPOINT,
      label: "GitHub Copilot request failed",
    });
    if (!res.ok) {
      return handleError(res, cred, (status, { text }) => {
        if (status === 401 || status === 404) {
          return {
            kind: "auth",
            message: "GitHub Copilot login invalid or not available for this account",
          };
        }
        if (status === 403) {
          return { kind: "no-plan", message: "GitHub Copilot is not enabled for this account" };
        }
        if (status === 429) {
          return { kind: "rate-limited", message: "GitHub Copilot rate limit reached" };
        }
        if (status >= 500) {
          return { kind: "network", message: `GitHub Copilot server error ${status}` };
        }
        return {
          kind: "bad-response",
          message: `GitHub Copilot unexpected status ${status}: ${text.slice(0, 200)}`,
        };
      });
    }

    const { json } = await readBody(res);
    const body = asRecord(json);
    if (!body) {
      throw new AdapterError(
        "bad-response",
        redact("GitHub Copilot response was not an object", cred.key),
      );
    }

    const snapshots = asRecord(body.quota_snapshots) ?? {};
    const reset = toISODate(body.quota_reset_date);
    const tokenBasedBilling = body.token_based_billing === true;

    const windows: UsageWindow[] = [];
    const extras: Record<string, string> = {};
    let unlimitedCount = 0;

    for (const { key, label } of SNAPSHOTS) {
      const snapshot = asRecord(snapshots[key]);
      if (!snapshot) continue;

      if (snapshot.unlimited === true) {
        unlimitedCount += 1;
        extras[label] = "unlimited";
        continue;
      }

      const entitlement = toNumber(snapshot.entitlement);
      const quotaRemaining = toNumber(snapshot.quota_remaining);
      if (snapshot.has_quota === false || (entitlement === null && quotaRemaining === null)) {
        continue;
      }

      const limit = toNumber(snapshot.entitlement ?? snapshot.quota_remaining);
      const remaining = toNumber(snapshot.remaining ?? snapshot.quota_remaining);
      const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null;

      const percentRemaining = toNumber(snapshot.percent_remaining);
      let usedPercent: number | null = null;
      if (percentRemaining !== null) {
        usedPercent = Math.min(100, Math.max(0, Math.round((100 - percentRemaining) * 10) / 10));
      } else if (used !== null && limit !== null && limit > 0) {
        usedPercent = Math.min(100, Math.max(0, Math.round((used / limit) * 1000) / 10));
      }

      const windowLabel =
        key === "premium_interactions"
          ? tokenBasedBilling
            ? "Monthly credits"
            : "Monthly premium requests"
          : key === "chat"
            ? "Chat (monthly)"
            : "Completions (monthly)";

      windows.push({
        kind: "monthly",
        label: windowLabel,
        usedPercent,
        used,
        limit,
        remaining,
        resetsAt: reset,
        status: remaining !== null && remaining <= 0 ? "rate-limited" : "ok",
      });
    }

    extras["Plan"] = copilotTier(body.access_type_sku, body.copilot_plan);

    // Billing extras come from the premium-interactions snapshot (the billed one).
    const premium = asRecord(snapshots["premium_interactions"]);
    const overage = premium ? toNumber(premium.overage_entitlement) : null;
    if (tokenBasedBilling && overage !== null && overage > 0) {
      extras["Additional usage budget"] = `$${(overage / 100).toFixed(2)}`;
    }
    const creditsUsed = premium ? toNumber(premium.credits_used) : null;
    if (creditsUsed !== null && creditsUsed > 0) {
      extras["Credits used"] = `${creditsUsed} credits ($${(creditsUsed / 100).toFixed(2)})`;
    }

    if (windows.length === 0 && unlimitedCount === 0) {
      throw new AdapterError(
        "bad-response",
        redact("GitHub Copilot response missing quota snapshots", cred.key),
      );
    }

    return { windows, extras };
  },
};
