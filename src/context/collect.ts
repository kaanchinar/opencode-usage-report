import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2";
import type { CollectInput, ContextBreakdown, ContextRow, RowKey, SystemCapture } from "./types";
import { estimateJson, estimateTokens } from "./estimate";
import { buildGrid } from "./grid";
import { computeHeadroom } from "./headroom";

const ROW_LABELS: Record<RowKey, string> = {
  user: "User messages",
  agent: "Agent responses",
  reasoning: "Reasoning",
  tools: "Tool calls",
  system: "System & tools",
  free: "Free space",
};

const MEASURED_KEYS: readonly RowKey[] = ["user", "agent", "reasoning", "tools", "system"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return String(value);
  } catch {
    return "";
  }
}

function isAssistant(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === "assistant";
}

function readParts(accessor: CollectInput["part"], messageID: string): readonly Part[] {
  if (typeof accessor !== "function") return [];
  try {
    const parts = accessor(messageID);
    return Array.isArray(parts) ? parts : [];
  } catch {
    return [];
  }
}

function lastReportingAssistant(messages: readonly unknown[]): AssistantMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isAssistant(message)) continue;
    const output = finiteOrNull(isRecord(message.tokens) ? message.tokens.output : undefined);
    if (output !== null && output > 0) return message;
  }
  return null;
}

function summaryStartIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isAssistant(message) && message.summary === true) return i + 1;
  }
  return 0;
}

function isUsableCapture(capture: SystemCapture | null | undefined): capture is SystemCapture {
  if (!isRecord(capture)) return false;
  const tokens = finiteOrNull(capture.systemTokens);
  return capture.version === 1 && tokens !== null && tokens >= 0;
}

/**
 * Scales `values` so they sum to `target` by the largest-remainder method; the
 * result never exceeds `target`. Used when raw `chars/4` estimates overshoot.
 */
function largestRemainderScale(
  values: readonly number[],
  target: number,
  divisor: number,
): number[] {
  if (!Number.isFinite(divisor) || divisor <= 0) return values.map(() => 0);
  const total = Math.max(0, Math.round(target));
  const scaled = values.map((value) => (value > 0 ? (value * total) / divisor : 0));
  const rounded = scaled.map((value) => Math.floor(value));
  let deficit = total - rounded.reduce((sum, value) => sum + value, 0);
  if (deficit <= 0) return rounded;

  const order = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);
  for (const { index } of order) {
    if (deficit <= 0) break;
    rounded[index] += 1;
    deficit -= 1;
  }
  return rounded;
}

function makeRow(
  key: RowKey,
  tokens: number | null,
  exact: boolean,
  limit: number | null,
): ContextRow {
  const percent =
    tokens !== null && limit !== null && limit > 0
      ? Math.min(100, Math.max(0, Math.round((tokens / limit) * 100)))
      : null;
  return { key, label: ROW_LABELS[key], tokens, percent, exact };
}

function emptyRows(limit: number | null): ContextRow[] {
  return [...MEASURED_KEYS, "free" as RowKey].map((key) =>
    makeRow(key, null, key === "free", limit),
  );
}

/**
 * Builds a `ContextBreakdown` from session messages. Exact prompt totals come
 * from the last reporting assistant message; the remaining rows are `chars/4`
 * estimates normalized against that total. Never throws and never emits NaN.
 */
export function collectContext(input: CollectInput): ContextBreakdown {
  const source = (isRecord(input) ? input : {}) as CollectInput;
  const messages: readonly unknown[] = Array.isArray(source.messages) ? source.messages : [];
  const limit = finiteOrNull(source.model?.limit?.context);
  const modelName = typeof source.model?.name === "string" ? source.model.name : null;
  const cost = finiteOrNull(source.sessionCost) ?? 0;
  const systemDerived = !isUsableCapture(source.system);
  const systemCaptured = systemDerived ? null : (source.system as SystemCapture).systemTokens;
  const cols = typeof source.cols === "number" && Number.isFinite(source.cols) ? source.cols : null;

  const last = lastReportingAssistant(messages);
  if (last === null) {
    const rows = emptyRows(limit);
    return {
      ready: false,
      modelName,
      total: null,
      limit,
      cost,
      rows,
      grid: buildGrid({ rows, limit, total: null, cols }),
      headroom: computeHeadroom({
        limit: source.model?.limit ?? null,
        total: null,
        compaction: source.compaction ?? null,
      }),
      systemDerived,
      systemCaptured,
      prunedToolOutputs: 0,
    };
  }

  const tokens: Record<string, unknown> = isRecord(last.tokens) ? last.tokens : {};
  const cache: Record<string, unknown> = isRecord(tokens.cache) ? tokens.cache : {};
  const total = Math.max(
    0,
    (finiteOrNull(tokens.input) ?? 0) +
      (finiteOrNull(cache.read) ?? 0) +
      (finiteOrNull(cache.write) ?? 0),
  );

  let userTokens = 0;
  let agentTokens = 0;
  let reasoningTokens = 0;
  let toolsTokens = 0;
  let prunedToolOutputs = 0;

  const start = summaryStartIndex(messages);
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const messageID = typeof message.id === "string" ? message.id : "";

    for (const part of readParts(source.part, messageID)) {
      if (!isRecord(part)) continue;
      const type = part.type;

      if (type === "text") {
        const estimated = estimateTokens(safeString(part.text));
        if (role === "user") userTokens += estimated;
        else agentTokens += estimated;
      } else if (type === "reasoning") {
        if (role === "assistant") reasoningTokens += estimateTokens(safeString(part.text));
      } else if (type === "file") {
        if (role === "user") {
          userTokens += estimateTokens(safeString(part.filename) + safeString(part.mime));
        }
      } else if (type === "tool") {
        const state = part.state;
        const stateRecord: Record<string, unknown> = isRecord(state) ? state : {};
        const timeRecord: Record<string, unknown> = isRecord(stateRecord.time)
          ? stateRecord.time
          : {};
        if (timeRecord.compacted !== undefined && timeRecord.compacted !== null) {
          prunedToolOutputs += 1;
          continue;
        }
        toolsTokens +=
          estimateJson(stateRecord.input) + estimateTokens(safeString(stateRecord.output));
      }
      // step-start, step-finish, snapshot and every other part type are skipped.
    }
  }

  const estimatedSum = userTokens + agentTokens + reasoningTokens + toolsTokens;
  let systemTokens = Math.max(0, total - estimatedSum);

  // chars/4 is an estimate in both directions; when it overshoots the exact
  // total, scale all five measured rows down so they sum to `total` (6.5).
  if (estimatedSum > total) {
    const scaled = largestRemainderScale(
      [userTokens, agentTokens, reasoningTokens, toolsTokens, systemTokens],
      total,
      estimatedSum,
    );
    userTokens = scaled[0];
    agentTokens = scaled[1];
    reasoningTokens = scaled[2];
    toolsTokens = scaled[3];
    systemTokens = scaled[4];
  }

  const measured = [userTokens, agentTokens, reasoningTokens, toolsTokens, systemTokens];
  const rows = MEASURED_KEYS.map((key, index) => makeRow(key, measured[index], false, limit));
  const freeTokens = limit !== null ? Math.max(0, limit - total) : null;
  rows.push(makeRow("free", freeTokens, true, limit));

  return {
    ready: true,
    modelName,
    total,
    limit,
    cost,
    rows,
    grid: buildGrid({ rows, limit, total, cols }),
    headroom: computeHeadroom({
      limit: source.model?.limit ?? null,
      total,
      compaction: source.compaction ?? null,
    }),
    systemDerived,
    systemCaptured,
    prunedToolOutputs,
  };
}
