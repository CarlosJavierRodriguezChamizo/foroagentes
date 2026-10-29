import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicLLM, thinkingFor, type MessagesClient } from "../engine/llm/anthropic";
import { MockLLM } from "../engine/llm/mock";
import { estimateCostUsd, PRICING } from "../engine/llm/pricing";
import type { LLMRequest } from "../engine/llm/types";

const req: LLMRequest = {
  purpose: "decide",
  model: "claude-sonnet-5-5",
  system: "sistema",
  user: "usuario",
  tool: { name: "decide", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  maxTokens: 1200,
};

describe("pricing", () => {
  it("calcula el coste estimado por millón de tokens", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(2);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 1_000_000 })).toBe(10);
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: 10_000, outputTokens: 1_000 })).toBeCloseTo(0.0015, 6);
  });

  it("usa una tarifa conservadora para modelos desconocidos", () => {
    expect(estimateCostUsd("modelo-raro", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(4);
    expect(Object.keys(PRICING)).toContain("claude-haiku-5-5");
  });
});

describe("MockLLM", () => {
  it("devuelve la cola de respuestas y registra las llamadas", async () => {
    const llm = MockLLM.queue([{ toolInput: { action: "pass", reason: "a" } }, { toolInput: null, text: "sin tool" }]);
    const a = await llm.call(req);
    const b = await llm.call(req);
    const c = await llm.call(req);
    expect(a.calledTool).toBe(true);
    expect(a.toolInput).toEqual({ action: "pass", reason: "a" });
    expect(b.calledTool).toBe(false);
    expect(c.calledTool).toBe(false);
    expect(llm.calls).toHaveLength(3);
    expect(a.usage.inputTokens).toBeGreaterThan(0);
  });

  it("puede simular errores", async () => {
    const llm = MockLLM.queue([{ toolInput: null, throws: new Error("boom") }]);
    await expect(llm.call(req)).rejects.toThrow("boom");
  });
});

describe("AnthropicLLM", () => {
  function fakeClient(content: Anthropic.ContentBlock[], capture: { params?: unknown }): MessagesClient {
    const create = (async (params: unknown) => {
      capture.params = params;
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1234, output_tokens: 321 },
      };
    }) as unknown as MessagesClient["messages"]["create"];
    return { messages: { create } };
  }

  it("envía la tool en modo estricto, sin forzarla, y extrae su entrada", async () => {
    const capture: { params?: unknown } = {};
    const llm = new AnthropicLLM(
      fakeClient(
        [{ type: "tool_use", id: "t1", name: "decide", input: { action: "pass", reason: "nada" } } as Anthropic.ToolUseBlock],
        capture,
      ),
    );
    const res = await llm.call(req);
    expect(res.calledTool).toBe(true);
    expect(res.toolInput).toEqual({ action: "pass", reason: "nada" });
    expect(res.usage).toEqual({ inputTokens: 1234, outputTokens: 321 });
    const params = capture.params as Record<string, unknown>;
    expect(params.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(params.thinking).toEqual({ type: "between_tools" });
    expect(params).not.toHaveProperty("temperature");
    expect((params.tools as Array<Record<string, unknown>>)[0]?.strict).toBe(true);
  });

  it("devuelve calledTool=false si el modelo solo escribe texto", async () => {
    const llm = new AnthropicLLM(fakeClient([{ type: "text", text: "hola", citations: null } as Anthropic.TextBlock], {}));
    const res = await llm.call(req);
    expect(res.calledTool).toBe(false);
    expect(res.text).toBe("hola");
  });

  it("elige la configuración de pensamiento según el modelo", () => {
    expect(thinkingFor("claude-sonnet-5-5").thinking).toEqual({ type: "between_tools" });
    expect(thinkingFor("claude-haiku-5-5").thinking).toEqual({ type: "disabled" });
    expect(thinkingFor("claude-opus-5-5").maxTokensMultiplier).toBeGreaterThan(1);
  });
});
