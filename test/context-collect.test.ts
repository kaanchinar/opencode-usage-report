import { describe, it, expect } from "vitest";
import type { Message, Model, Part } from "@opencode-ai/sdk/v2";
import { collectContext } from "@/context/collect";
import type { CollectInput, ContextBreakdown, RowKey, SystemCapture } from "@/context/types";

function userMessage(id: string, extra: Record<string, unknown> = {}): Message {
  return {
    id,
    sessionID: "s1",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p1", modelID: "m1" },
    ...extra,
  } as unknown as Message;
}

function assistantMessage(
  id: string,
  tokens: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Message {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    time: { created: 1 },
    parentID: "u1",
    modelID: "m1",
    providerID: "p1",
    mode: "build",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, ...tokens },
    ...extra,
  } as unknown as Message;
}

function testModel(context: number | null, limitExtra: Record<string, unknown> = {}): Model {
  return {
    name: "Test Model",
    limit: { context, output: 1000, ...limitExtra },
  } as unknown as Model;
}

function textPart(text: string): Part {
  return { id: "part", sessionID: "s1", messageID: "", type: "text", text } as unknown as Part;
}
function reasoningPart(text: string): Part {
  return { id: "part", sessionID: "s1", messageID: "", type: "reasoning", text } as unknown as Part;
}
function filePart(filename: string, mime: string): Part {
  return {
    id: "part",
    sessionID: "s1",
    messageID: "",
    type: "file",
    filename,
    mime,
    url: "file:///x",
  } as unknown as Part;
}
function toolPart(state: unknown): Part {
  return {
    id: "part",
    sessionID: "s1",
    messageID: "",
    type: "tool",
    callID: "c",
    tool: "t",
    state,
  } as unknown as Part;
}
function simplePart(type: string): Part {
  return { id: "part", sessionID: "s1", messageID: "", type } as unknown as Part;
}

function accessor(map: Record<string, Part[]>): (id: string) => readonly Part[] {
  return (id) => map[id] ?? [];
}

function value(breakdown: ContextBreakdown, key: RowKey): number | null {
  return breakdown.rows.find((row) => row.key === key)?.tokens ?? null;
}

function containsNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some(containsNaN);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsNaN);
  return false;
}

function validCapture(extra: Record<string, unknown> = {}): SystemCapture {
  return {
    version: 1,
    sessionID: "s1",
    providerID: "p1",
    modelID: "m1",
    systemChars: 10,
    systemTokens: 5,
    capturedAt: 1,
    ...extra,
  } as SystemCapture;
}

describe("collectContext empty states", () => {
  it("marks an empty session not ready with a hollow grid", () => {
    const breakdown = collectContext({ messages: [], model: testModel(1000), cols: 10 });
    expect(breakdown.ready).toBe(false);
    expect(breakdown.total).toBeNull();
    expect(breakdown.limit).toBe(1000);
    expect(breakdown.modelName).toBe("Test Model");
    expect(breakdown.rows).toHaveLength(6);
    expect(breakdown.rows.every((row) => row.tokens === null && row.percent === null)).toBe(true);
    expect(breakdown.grid.cells).toHaveLength(60);
    expect(breakdown.grid.cells.every((cell) => cell.rowKey === null && cell.fill === 0)).toBe(
      true,
    );
    expect(breakdown.prunedToolOutputs).toBe(0);
    expect(breakdown.systemDerived).toBe(true);
    expect(containsNaN(breakdown)).toBe(false);
  });

  it("stays not ready with a user message but no assistant response", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1")],
      model: testModel(1000),
      part: accessor({ u1: [textPart("hello")] }),
    });
    expect(breakdown.ready).toBe(false);
    expect(breakdown.total).toBeNull();
  });

  it("is not ready when the only assistant message reported no output", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 100, output: 0 })],
      model: testModel(1000),
    });
    expect(breakdown.ready).toBe(false);
  });
});

describe("collectContext totals", () => {
  it("counts cache tokens exactly once and excludes output/reasoning", () => {
    const breakdown = collectContext({
      messages: [
        assistantMessage("a1", {
          input: 100,
          output: 50,
          reasoning: 30,
          cache: { read: 20, write: 5 },
        }),
      ],
      model: testModel(1000),
    });
    expect(breakdown.ready).toBe(true);
    expect(breakdown.total).toBe(125);
    expect(breakdown.limit).toBe(1000);
  });

  it("splits the measured rows so they sum to the total", () => {
    const breakdown = collectContext({
      messages: [
        userMessage("u1"),
        assistantMessage("a1", { input: 100, cache: { read: 20, write: 5 } }),
      ],
      model: testModel(1000),
      part: accessor({ u1: [textPart("hello world!")] }),
    });
    const measured = ["user", "agent", "reasoning", "tools", "system"] as RowKey[];
    const sum = measured.reduce((acc, key) => acc + (value(breakdown, key) ?? 0), 0);
    expect(sum).toBe(breakdown.total);
    expect(value(breakdown, "user")).toBe(3);
    expect(value(breakdown, "system")).toBe(122);
    expect(value(breakdown, "free")).toBe(875);
  });

  it("never reports a percentage over 100", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 2000 })],
      model: testModel(1000),
    });
    expect(breakdown.total).toBe(2000);
    expect(
      breakdown.rows.every(
        (row) => row.percent === null || (row.percent >= 0 && row.percent <= 100),
      ),
    ).toBe(true);
    expect(breakdown.rows.some((row) => row.percent === 100)).toBe(true);
    expect(value(breakdown, "free")).toBe(0);
  });
});

describe("collectContext part classification", () => {
  it("classifies user text/file, assistant text/reasoning, and tools", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1"), assistantMessage("a1", { input: 500 })],
      model: testModel(1000),
      part: accessor({
        u1: [textPart("a".repeat(8)), filePart("a.txt", "text/plain")],
        a1: [
          textPart("b".repeat(40)),
          reasoningPart("c".repeat(20)),
          toolPart({ status: "completed", input: { x: 1 }, output: "hello" }),
          simplePart("step-start"),
          simplePart("step-finish"),
          simplePart("snapshot"),
        ],
      }),
    });
    expect(value(breakdown, "user")).toBe(6);
    expect(value(breakdown, "agent")).toBe(10);
    expect(value(breakdown, "reasoning")).toBe(5);
    expect(value(breakdown, "tools")).toBe(3);
    expect(value(breakdown, "system")).toBe(476);
    expect(breakdown.prunedToolOutputs).toBe(0);
  });

  it("skips compacted tool outputs and counts them", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      part: accessor({
        a1: [
          toolPart({
            status: "completed",
            input: { x: 1 },
            output: "hello",
            time: { start: 1, end: 2, compacted: 99 },
          }),
          toolPart({
            status: "completed",
            input: { y: 2 },
            output: "ok",
            time: { start: 1, end: 2 },
          }),
        ],
      }),
    });
    expect(breakdown.prunedToolOutputs).toBe(1);
    expect(value(breakdown, "tools")).toBe(3);
  });

  it("ignores step and snapshot parts", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      part: accessor({
        a1: [
          simplePart("step-start"),
          simplePart("step-finish"),
          simplePart("snapshot"),
          simplePart("patch"),
        ],
      }),
    });
    expect(value(breakdown, "agent")).toBe(0);
    expect(value(breakdown, "reasoning")).toBe(0);
    expect(value(breakdown, "tools")).toBe(0);
    expect(value(breakdown, "system")).toBe(100);
  });

  it("excludes messages before the last summary assistant", () => {
    const breakdown = collectContext({
      messages: [
        userMessage("u0"),
        assistantMessage("a0", { output: 0 }, { summary: true }),
        userMessage("u1"),
        assistantMessage("a1", { input: 100 }),
      ],
      model: testModel(1000),
      part: accessor({
        u0: [textPart("x".repeat(4000))],
        u1: [textPart("y".repeat(8))],
      }),
    });
    expect(value(breakdown, "user")).toBe(2);
    expect(value(breakdown, "system")).toBe(98);
  });
});

describe("collectContext residual and normalization", () => {
  it("clamps the residual system row at 0 when estimates overshoot", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1"), assistantMessage("a1", { input: 10 })],
      model: testModel(1000),
      part: accessor({ u1: [textPart("x".repeat(4000))] }),
    });
    const measured = ["user", "agent", "reasoning", "tools", "system"] as RowKey[];
    const sum = measured.reduce((acc, key) => acc + (value(breakdown, key) ?? 0), 0);
    expect(value(breakdown, "system")).toBe(0);
    expect(sum).toBe(10);
  });

  it("scales proportionally when estimates overshoot", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1"), assistantMessage("a1", { input: 10 })],
      model: testModel(1000),
      part: accessor({
        u1: [textPart("a".repeat(16))],
        a1: [textPart("b".repeat(16)), reasoningPart("c".repeat(16))],
      }),
    });
    expect(value(breakdown, "user")).toBe(3);
    expect(value(breakdown, "agent")).toBe(3);
    expect(value(breakdown, "reasoning")).toBe(3);
    expect(value(breakdown, "system")).toBe(0);
    const sum =
      (value(breakdown, "user") ?? 0) +
      (value(breakdown, "agent") ?? 0) +
      (value(breakdown, "reasoning") ?? 0) +
      (value(breakdown, "system") ?? 0);
    expect(sum).toBeLessThanOrEqual(10);
    expect(sum).toBeGreaterThan(0);
  });

  it("is a no-op when estimates are under the total", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1"), assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      part: accessor({ u1: [textPart("x".repeat(40))] }),
    });
    expect(value(breakdown, "user")).toBe(10);
    expect(value(breakdown, "system")).toBe(90);
    expect(value(breakdown, "agent")).toBe(0);
  });
});

describe("collectContext unknown limit", () => {
  it("nulls percentages and empties the grid when limit.context is missing", () => {
    const model = { name: "No Context", limit: { output: 1000 } } as unknown as Model;
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 50 })],
      model,
    });
    expect(breakdown.ready).toBe(true);
    expect(breakdown.total).toBe(50);
    expect(breakdown.limit).toBeNull();
    expect(breakdown.rows.every((row) => row.percent === null)).toBe(true);
    expect(value(breakdown, "free")).toBeNull();
    expect(breakdown.grid.cells).toEqual([]);
  });
});

describe("collectContext defensiveness", () => {
  it("coerces non-string tool output and tolerates missing state", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      part: accessor({
        a1: [
          toolPart({
            status: "completed",
            input: { a: 1 },
            output: 12345,
            time: { start: 1, end: 2 },
          }),
          toolPart(undefined),
          toolPart({}),
          toolPart(null),
        ],
      }),
    });
    expect(value(breakdown, "tools")).toBe(3);
    expect(containsNaN(breakdown)).toBe(false);
  });

  it("skips null message and part entries", () => {
    const messages = [
      null,
      userMessage("u1"),
      assistantMessage("a1", { input: 100 }),
    ] as unknown as Message[];
    const parts = accessor({ u1: [null as unknown as Part, textPart("abcd")] });
    const breakdown = collectContext({ messages, model: testModel(1000), part: parts });
    expect(breakdown.ready).toBe(true);
    expect(value(breakdown, "user")).toBe(1);
    expect(containsNaN(breakdown)).toBe(false);
  });

  it("tolerates a missing or null part accessor", () => {
    const base = { messages: [assistantMessage("a1", { input: 100 })], model: testModel(1000) };
    expect(() => collectContext(base)).not.toThrow();
    expect(() => collectContext({ ...base, part: null })).not.toThrow();
    const breakdown = collectContext(base);
    expect(value(breakdown, "user")).toBe(0);
    expect(value(breakdown, "system")).toBe(100);
  });

  it("tolerates a throwing part accessor", () => {
    const breakdown = collectContext({
      messages: [userMessage("u1"), assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      part: () => {
        throw new Error("boom");
      },
    });
    expect(value(breakdown, "user")).toBe(0);
    expect(value(breakdown, "system")).toBe(100);
    expect(containsNaN(breakdown)).toBe(false);
  });

  it("sets systemDerived unless the capture is valid", () => {
    const base: CollectInput = {
      messages: [assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
    };
    expect(collectContext(base).systemDerived).toBe(true);
    expect(collectContext({ ...base, system: null }).systemDerived).toBe(true);
    expect(collectContext({ ...base, system: validCapture() }).systemDerived).toBe(false);
    expect(collectContext({ ...base, system: validCapture({ version: 2 }) }).systemDerived).toBe(
      true,
    );
    expect(
      collectContext({ ...base, system: validCapture({ systemTokens: Number.NaN }) }).systemDerived,
    ).toBe(true);
  });

  it("keeps the residual value even with a valid capture", () => {
    const breakdown = collectContext({
      messages: [assistantMessage("a1", { input: 100 })],
      model: testModel(1000),
      system: validCapture(),
    });
    expect(value(breakdown, "system")).toBe(100);
    expect(breakdown.systemDerived).toBe(false);
  });

  it("never returns NaN across representative inputs", () => {
    const inputs: CollectInput[] = [
      { messages: [], model: testModel(1000) },
      { messages: [assistantMessage("a1", { input: 100 })], model: testModel(1000) },
      { messages: [assistantMessage("a1", { input: 100 })], model: null },
      {
        messages: [userMessage("u1"), assistantMessage("a1", { input: 5 })],
        model: testModel(10),
        part: accessor({ u1: [textPart("x".repeat(9000))] }),
      },
      {
        messages: [
          {
            role: "assistant",
            id: "broken",
            tokens: { output: 1, input: "nope", cache: null },
          } as unknown as Message,
        ],
        model: testModel(100),
      },
    ];
    for (const input of inputs) {
      const breakdown = collectContext(input);
      expect(containsNaN(breakdown)).toBe(false);
    }
  });
});
