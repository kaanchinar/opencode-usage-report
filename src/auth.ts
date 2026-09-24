import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Credential } from "./types";
import { dataHome } from "./paths";

/** "kimi-code-plan-global" -> "OPENCODE_USAGE_KIMI_CODE_PLAN_GLOBAL_KEY" (non-alphanumerics become "_", uppercased). */
export function envVarName(providerId: string): string {
  return providerEnvVarName(providerId, "KEY");
}

/** "openai" -> "OPENCODE_USAGE_OPENAI_ACCOUNT_ID" (same normalization as envVarName). */
export function accountIdEnvVarName(providerId: string): string {
  return providerEnvVarName(providerId, "ACCOUNT_ID");
}

function providerEnvVarName(providerId: string, suffix: string): string {
  const normalized = providerId.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return `OPENCODE_USAGE_${normalized}_${suffix}`;
}

/**
 * Resolves a credential for a provider id.
 * Order: (1) env override (empty string = missing), (2) auth.json entry.
 * Never throws; returns null when no usable credential is found.
 */
export function resolveCredential(
  providerId: string,
  opts: { env?: NodeJS.ProcessEnv; dataHomeDir?: string } = {},
): Credential | null {
  try {
    const env = opts.env ?? process.env;

    const override = env[envVarName(providerId)];
    if (typeof override === "string" && override.trim() !== "") {
      const accountId = env[accountIdEnvVarName(providerId)];
      return typeof accountId === "string" && accountId.trim() !== ""
        ? { type: "api", key: override, accountId }
        : { type: "api", key: override };
    }

    const dir = opts.dataHomeDir ?? dataHome(env);
    const raw = readFileSync(join(dir, "auth.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

    const entry = (parsed as Record<string, unknown>)[providerId];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;

    const record = entry as Record<string, unknown>;
    if (record.type === "api") {
      const key = record.key;
      return typeof key === "string" && key !== "" ? { type: "api", key } : null;
    }
    if (record.type === "oauth") {
      // Prefer the access token. opencode stores the GitHub Copilot token in
      // `refresh` (there is no access token), so fall back to it there only;
      // other oauth providers keep the access-only behavior.
      const access = record.access;
      let key = typeof access === "string" && access !== "" ? access : null;
      if (key === null && providerId === "github-copilot") {
        const refresh = record.refresh;
        if (typeof refresh === "string" && refresh !== "") key = refresh;
      }
      if (key === null) return null;

      const accountId = record.accountId;
      return typeof accountId === "string" && accountId !== ""
        ? { type: "oauth", key, accountId }
        : { type: "oauth", key };
    }
    return null;
  } catch {
    return null;
  }
}

/** Replaces every occurrence of key material (len >= 8) with "<redacted>". Short/null keys are ignored. */
export function redact(text: string, key: string | null): string {
  if (!key || key.length < 8) return text;
  return text.split(key).join("<redacted>");
}
