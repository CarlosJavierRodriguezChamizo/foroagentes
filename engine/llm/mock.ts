import type { LLMClient, LLMRequest, LLMResponse, Usage } from "./types";
import { estimateTokens } from "../forum/util";

export interface MockReply {
  /** Entrada de la tool. `null` simula un modelo que contesta sin llamar a la tool. */
  toolInput: unknown;
  text?: string;
  usage?: Partial<Usage>;
  /** Motivo de parada simulado (p. ej. "max_tokens"). */
  stopReason?: string;
  /** Si se define, la llamada lanza este error (para probar fallos de red/API). */
  throws?: Error;
}

export type MockHandler = (req: LLMRequest, callIndex: number) => MockReply;

/**
 * LLM falso y determinista. Registra todas las peticiones para poder inspeccionarlas en tests.
 * Los tokens se estiman por caracteres/4 para que la contabilidad de coste tenga valores realistas.
 */
export class MockLLM implements LLMClient {
  readonly name = "mock";
  readonly calls: LLMRequest[] = [];

  constructor(private readonly handler: MockHandler) {}

  /** Responde con una cola fija de respuestas; cuando se agota, repite la última. */
  static queue(replies: MockReply[]): MockLLM {
    if (replies.length === 0) throw new Error("MockLLM.queue necesita al menos una respuesta");
    return new MockLLM((_req, i) => replies[Math.min(i, replies.length - 1)] as MockReply);
  }

  async call(req: LLMRequest): Promise<LLMResponse> {
    const index = this.calls.length;
    this.calls.push(req);
    const reply = this.handler(req, index);
    if (reply.throws) throw reply.throws;
    const output = reply.toolInput === null ? (reply.text ?? "") : JSON.stringify(reply.toolInput);
    return {
      toolInput: reply.toolInput,
      calledTool: reply.toolInput !== null,
      text: reply.text ?? "",
      stopReason: reply.stopReason ?? (reply.toolInput === null ? "end_turn" : "tool_use"),
      usage: {
        inputTokens: reply.usage?.inputTokens ?? estimateTokens(req.system + req.user) + 400,
        outputTokens: reply.usage?.outputTokens ?? estimateTokens(output) + 20,
      },
      model: req.model,
    };
  }
}
