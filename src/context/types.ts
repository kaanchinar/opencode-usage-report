import type { Message, Model, Part } from "@opencode-ai/sdk/v2";

export type RowKey = "user" | "agent" | "reasoning" | "tools" | "system" | "free";

export interface ContextRow {
  key: RowKey;
  label: string;
  tokens: number | null;
  percent: number | null; // 0-100, null when the limit is unknown
  exact: boolean;
}

export interface GridCell {
  rowKey: RowKey | null; // null = free space
  fill: number; // 0..1
}

export interface ContextBreakdown {
  ready: boolean;
  modelName: string | null;
  total: number | null;
  limit: number | null;
  cost: number;
  rows: ContextRow[];
  grid: { cols: number; rows: number; cells: GridCell[] };
  headroom: { usable: number | null; free: number | null; band: "ok" | "warning" | "error" };
  systemDerived: boolean;
  /** Measured system-prompt tokens when a valid capture was supplied, else null. */
  systemCaptured: number | null;
  prunedToolOutputs: number;
}

export interface SystemCapture {
  version: 1;
  sessionID: string;
  providerID: string;
  modelID: string;
  systemChars: number;
  systemTokens: number;
  capturedAt: number;
}

export interface CollectInput {
  messages: readonly Message[];
  model: Model | null;
  part?: ((messageID: string) => readonly Part[]) | null;
  system?: SystemCapture | null;
  sessionCost?: number;
  cols?: number | null;
  compaction?: { reserved?: number } | null;
}
