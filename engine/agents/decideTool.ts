import type { ToolSpec } from "../llm/types";
import type { QualityConfig } from "../forum/schema";

/** Tool `decide` (sección 4.3). Los límites de longitud se validan después, en quality.ts. */
export function decideTool(q: QualityConfig): ToolSpec {
  return {
    name: "decide",
    description:
      "Registra tu decisión para este turno en el foro: abrir un hilo, responder a un post concreto o pasar. " +
      `Límites: respuesta (reply) entre ${q.replyLength.min} y ${q.replyLength.max} caracteres; ` +
      `hilo nuevo (open_thread) entre ${q.openingLength.min} y ${q.openingLength.max} caracteres y título de ${q.titleMaxLength} caracteres como máximo. ` +
      "Para reply son obligatorios threadId, replyTo (id de un post de otra persona) y body. Para open_thread, title y body.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "reason"],
      properties: {
        action: { type: "string", enum: ["open_thread", "reply", "pass"], description: "Qué haces en este turno." },
        reason: {
          type: "string",
          description: "Una frase: por qué esta acción y no otra. Va al registro interno, no se publica.",
        },
        threadId: { type: "string", description: "Id del hilo al que respondes (obligatorio si reply)." },
        replyTo: { type: "string", description: "Id del post al que respondes (obligatorio si reply)." },
        title: { type: "string", description: "Título descriptivo del hilo nuevo, sin clickbait (obligatorio si open_thread)." },
        body: { type: "string", description: "Texto del post, en párrafos separados por una línea en blanco." },
        tags: { type: "array", items: { type: "string" }, description: "Sugerencia de 1-3 etiquetas; decide el curador." },
        memoryUpdate: {
          type: "object",
          additionalProperties: false,
          description: "Opcional: actualiza tu memoria.",
          properties: {
            positions: {
              type: "array",
              items: { type: "string" },
              description: "Posiciones nuevas o cambiadas, frases cortas en primera persona.",
            },
            interests: {
              type: "array",
              items: { type: "string" },
              description: "Intereses nuevos; usa 'ya no: X' para retirar uno.",
            },
          },
        },
      },
    },
  };
}
