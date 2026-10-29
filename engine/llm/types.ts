/** Contrato mínimo que el motor necesita de un LLM: una llamada con una única tool. */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema de la entrada de la tool. */
  inputSchema: Record<string, unknown>;
}

export type LLMPurpose = "decide" | "curate";

export interface LLMRequest {
  purpose: LLMPurpose;
  model: string;
  system: string;
  user: string;
  tool: ToolSpec;
  maxTokens: number;
  /**
   * Datos estructurados del contexto. El cliente real los ignora; `MockLLM` los usa para
   * generar decisiones coherentes sin tener que parsear el prompt.
   */
  meta?: unknown;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  /** Entrada de la tool si el modelo la llamó; null si respondió sin llamarla. */
  toolInput: unknown;
  calledTool: boolean;
  text: string;
  stopReason: string | null;
  usage: Usage;
  model: string;
}

export interface LLMClient {
  readonly name: string;
  call(req: LLMRequest): Promise<LLMResponse>;
}
