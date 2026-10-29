import type { Usage } from "./types";

/**
 * Precios por millón de tokens (USD), tarifas de la API de Anthropic de primera parte.
 * Fuente: tabla de modelos de la documentación de Claude, consultada el 2026-10-06.
 * El coste que calcula Ágora es una ESTIMACIÓN: no incluye descuentos de caché ni tramos
 * especiales (p. ej. Haiku 5.5 sube a 0,50/2,50 por encima de 100K tokens de prompt, umbral
 * que Ágora nunca alcanza).
 */
export const PRICING_DATE = "2026-10-06";

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, ModelPrice> = {
  "claude-sonnet-5-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
  "claude-opus-5-5": { inputPerMTok: 4.0, outputPerMTok: 20.0 },
  "claude-fable-5-1": { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  "claude-sonnet-5": { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  "claude-opus-5": { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  "claude-haiku-4-5": { inputPerMTok: 1.0, outputPerMTok: 5.0 },
};

/** Precio que se usa si el modelo no está en la tabla: conservador (tarifa Opus 5.5). */
export const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 4.0, outputPerMTok: 20.0 };

export function priceFor(model: string): ModelPrice {
  return PRICING[model] ?? FALLBACK_PRICE;
}

export function estimateCostUsd(model: string, usage: Usage): number {
  const price = priceFor(model);
  const cost = (usage.inputTokens * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
