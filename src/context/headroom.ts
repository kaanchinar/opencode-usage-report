import type { Model } from "@opencode-ai/sdk/v2";

export interface Headroom {
  usable: number | null;
  free: number | null;
  band: "ok" | "warning" | "error";
}

export interface HeadroomInput {
  limit: Model["limit"] | null | undefined;
  total: number | null;
  compaction?: { reserved?: number } | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Compaction headroom, mirroring opencode's overflow check; nulls when unusable. */
export function computeHeadroom(input: HeadroomInput): Headroom {
  const limit = input.limit;
  const context = finiteOrNull(limit?.context);
  const maxOutput = finiteOrNull(limit?.output);
  if (context === null || maxOutput === null) return { usable: null, free: null, band: "ok" };

  const reservedDefault = Math.min(20000, Math.max(0, maxOutput));
  const configured = finiteOrNull(input.compaction?.reserved);
  const reserved = configured !== null && configured >= 0 ? configured : reservedDefault;

  const inputLimit = finiteOrNull(limit?.input);
  const usable =
    inputLimit !== null
      ? Math.max(0, inputLimit - reserved)
      : Math.max(0, context - Math.max(0, maxOutput));

  const total = finiteOrNull(input.total);
  if (total === null) return { usable, free: null, band: "ok" };

  const free = usable - total;
  const band = free <= usable * 0.05 ? "error" : free <= usable * 0.15 ? "warning" : "ok";
  return { usable, free, band };
}
