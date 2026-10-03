import { describe, it, expect, vi } from "vitest";
import type { RGBA } from "@opentui/core";
import {
  asV1Theme,
  createV2Api,
  v2ProviderModels,
  v2ThemeColors,
  type V2Context,
  type V2Data,
  type V2Theme,
} from "@/v2-tui";

const color = (name: string): RGBA => name as unknown as RGBA;

const renderStub = (): null => null;

function fullTheme(): V2Theme {
  return {
    text: {
      base: color("base"),
      muted: color("muted"),
      feedback: {
        error: { base: color("error") },
        warning: { base: color("warning") },
        success: { base: color("success") },
        info: { base: color("info") },
      },
    },
    border: { base: color("border") },
    hue: { accent: { 500: color("accent") }, interactive: { 500: color("interactive") } },
  };
}

describe("v2ThemeColors", () => {
  it("maps the 2.0.8+ token names", () => {
    expect(v2ThemeColors(fullTheme())).toEqual({
      text: color("base"),
      textMuted: color("muted"),
      accent: color("accent"),
      secondary: color("interactive"),
      info: color("info"),
      success: color("success"),
      warning: color("warning"),
      error: color("error"),
      borderSubtle: color("border"),
    });
  });

  it("maps the pre-2.0.8 spelling (default/subdued) and falls back when tokens are absent", () => {
    const legacy: V2Theme = {
      text: { default: color("legacyText"), subdued: color("legacyMuted") },
    };
    const colors = v2ThemeColors(legacy);
    expect(colors.text).toBe(color("legacyText"));
    expect(colors.textMuted).toBe(color("legacyMuted"));
    expect(colors.error).toBe(color("legacyText"));
    expect(colors.accent).toBe(color("legacyText"));
    expect(colors.borderSubtle).toBe(color("legacyMuted"));
  });

  it("exposes exactly the V1 keys the renderers resolve", () => {
    expect(Object.keys(asV1Theme(v2ThemeColors(fullTheme()))).toSorted()).toEqual(
      [
        "accent",
        "borderSubtle",
        "error",
        "info",
        "secondary",
        "success",
        "text",
        "textMuted",
        "warning",
      ].toSorted(),
    );
  });
});

function makeData(init: {
  messages?: readonly unknown[];
  providers?: readonly { id: string }[];
  models?: readonly { id: string; modelID: string; providerID: string; name: string }[];
  cost?: number;
}): V2Data {
  return {
    on: () => () => {},
    session: {
      cost: () => init.cost ?? 0,
      message: { list: () => init.messages ?? [] },
    },
    location: {
      provider: { list: () => init.providers ?? [] },
      model: { list: () => init.models ?? [] },
    },
  };
}

function makeCtx(
  data: V2Data,
  extra: Partial<V2Context> = {},
): V2Context & {
  dialog: {
    show: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
} {
  const dialog = {
    show: vi.fn<(render: () => unknown, onClose?: () => void) => void>(),
    set: vi.fn<(options: { size?: "medium" | "large" | "xlarge" }) => void>(),
    clear: vi.fn<() => void>(),
  };
  return {
    options: {},
    theme: fullTheme(),
    data,
    dialog,
    ui: {
      slot: () => () => {},
      dialog,
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
    },
    keymap: { layer: () => {} },
    ...extra,
  };
}

describe("createV2Api", () => {
  it("reports the active session through the V1 route shape", () => {
    const api = createV2Api(makeCtx(makeData({})));
    expect(api.route.current).toEqual({ name: "session", params: { sessionID: "ses_1" } });
  });

  it("translates V2 messages and exposes their inline parts by message id", () => {
    const data = makeData({
      messages: [
        {
          id: "u1",
          type: "user",
          text: "hello",
          files: [{ filename: "a.ts", mime: "text/plain" }],
        },
        {
          id: "a1",
          type: "assistant",
          model: { providerID: "kimi", modelID: "k2" },
          content: [
            { type: "text", text: "hi" },
            { type: "reasoning", text: "hmm" },
          ],
          tokens: { input: 10, output: 5, cache: { read: 2, write: 1 } },
          time: { created: 7 },
        },
      ],
    });
    const api = createV2Api(makeCtx(data));

    const messages = api.state.session.messages("ses_1") as unknown as Array<
      Record<string, unknown>
    >;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "u1", role: "user" });
    expect(messages[1]).toMatchObject({
      id: "a1",
      role: "assistant",
      providerID: "kimi",
      modelID: "k2",
    });
    expect((messages[1].tokens as Record<string, unknown>).output).toBe(5);
    expect(api.state.part("a1")).toHaveLength(2);
    expect(api.state.part("missing")).toEqual([]);
    expect((api.state.session.get("ses_1") as unknown as { cost: number }).cost).toBe(0);
  });

  it("never throws when an assistant message has no tokens (UsageDialog reads .tokens.output)", () => {
    const data = makeData({ messages: [{ id: "a1", type: "assistant" }] });
    const api = createV2Api(makeCtx(data));
    const messages = api.state.session.messages("ses_1") as unknown as Array<{
      tokens: { output: number };
    }>;
    expect(messages[0].tokens.output).toBe(0);
  });

  it("forwards the V1 dialog calls to the V2 stack", () => {
    const ctx = makeCtx(makeData({}));
    const api = createV2Api(ctx);
    api.ui.dialog.replace(renderStub);
    api.ui.dialog.setSize("xlarge");
    api.ui.dialog.clear();
    expect(ctx.dialog.show).toHaveBeenCalledWith(renderStub, undefined);
    expect(ctx.dialog.set).toHaveBeenCalledWith({ size: "xlarge" });
    expect(ctx.dialog.clear).toHaveBeenCalledOnce();
  });
});

describe("v2ProviderModels", () => {
  it("groups models under their provider", () => {
    const data = makeData({
      providers: [{ id: "kimi" }, { id: "other" }],
      models: [
        { id: "k2", modelID: "k2", providerID: "kimi", name: "K2" },
        { id: "k3", modelID: "k3", providerID: "kimi", name: "K3" },
      ],
    });
    const providers = v2ProviderModels(data);
    expect(providers.map((p) => p.id)).toEqual(["kimi", "other"]);
    expect(Object.keys(providers[0].models)).toEqual(["k2", "k3"]);
    expect(providers[1].models).toEqual({});
  });
});
