import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, LLMRequest, LLMResponse } from "./types";

/** Timeout por llamada (ms). */
export const CALL_TIMEOUT_MS = 90_000;
/** Reintentos ante 408/409/429/5xx y errores de conexión; el SDK aplica backoff exponencial. */
export const MAX_RETRIES = 2;

interface ThinkingSetup {
  thinking: Anthropic.ThinkingConfigParam;
  maxTokensMultiplier: number;
}

/**
 * Los posts del foro no necesitan razonamiento extendido y `max_tokens` es pequeño (3.000), así
 * que el pensamiento se apaga donde el modelo lo permite:
 * - Sonnet 5.5 no acepta `disabled`; su ajuste mínimo es `between_tools`.
 * - Haiku 5.5 acepta `disabled` con esfuerzo `high` o menor (su defecto es `medium`).
 * - Cualquier otro modelo: pensamiento adaptativo y margen de tokens para que no se coma la respuesta.
 */
export function thinkingFor(model: string): ThinkingSetup {
  if (model.startsWith("claude-sonnet-5-5")) return { thinking: { type: "between_tools" }, maxTokensMultiplier: 1 };
  if (model.startsWith("claude-haiku-5-5")) return { thinking: { type: "disabled" }, maxTokensMultiplier: 1 };
  return { thinking: { type: "adaptive" }, maxTokensMultiplier: 4 };
}

/** Subconjunto del SDK que usamos; permite inyectar un cliente falso en los tests. */
export interface MessagesClient {
  messages: Pick<Anthropic["messages"], "create">;
}

export class AnthropicLLM implements LLMClient {
  readonly name = "anthropic";
  private readonly client: MessagesClient;

  constructor(client?: MessagesClient) {
    this.client = client ?? new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const setup = thinkingFor(req.model);
    const response = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens * setup.maxTokensMultiplier,
        thinking: setup.thinking,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        tools: [
          {
            name: req.tool.name,
            description: req.tool.description,
            input_schema: req.tool.inputSchema as Anthropic.Tool.InputSchema,
            strict: true,
          },
        ],
        // Sonnet 5.5 no admite forzar la tool (`any`/`tool` devuelven 400): se pide en el prompt.
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
      },
      { timeout: CALL_TIMEOUT_MS, maxRetries: MAX_RETRIES },
    );

    let toolInput: unknown = null;
    let calledTool = false;
    const texts: string[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === req.tool.name && !calledTool) {
        toolInput = block.input;
        calledTool = true;
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    return {
      toolInput,
      calledTool,
      text: texts.join("\n"),
      stopReason: response.stop_reason,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
      model: response.model,
    };
  }
}
