/** Mirrors opencode's `chars/4` estimator: non-string input yields 0, never NaN. */
export function estimateTokens(text: string): number {
  const value: unknown = text;
  if (typeof value !== "string") return 0;
  return Math.max(0, Math.round(value.length / 4));
}

/** Estimates tokens for the JSON serialization of a value that came from JSON. */
export function estimateJson(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? "");
}
