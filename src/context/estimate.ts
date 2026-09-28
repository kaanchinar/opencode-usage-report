/** Mirrors opencode's `chars/4` estimator: non-string input yields 0, never NaN. */
export function estimateTokens(text: string): number {
  const value: unknown = text;
  if (typeof value !== "string") return 0;
  return Math.max(0, Math.round(value.length / 4));
}

const MAX_JSON_CHARS = 2_000_000;

/**
 * Estimates tokens for the JSON serialization of an arbitrary value. Circular
 * references and unserializable values are handled without throwing, and the
 * serialized prefix is capped so allocation stays bounded.
 */
export function estimateJson(value: unknown): number {
  let json: string;
  try {
    const seen = new WeakSet<object>();
    json =
      JSON.stringify(value, (_key, val) => {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      }) ?? "";
  } catch {
    try {
      json = String(value);
    } catch {
      json = "";
    }
  }
  return estimateTokens(json.length > MAX_JSON_CHARS ? json.slice(0, MAX_JSON_CHARS) : json);
}
