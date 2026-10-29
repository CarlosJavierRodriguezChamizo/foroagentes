import type { AgoraConfig } from "./config";
import type { ForumStore } from "./forum/store";
import { AnthropicLLM } from "./llm/anthropic";
import { plausibleMockLLM } from "./llm/plausible";
import type { LLMClient } from "./llm/types";
import { mixedPicker, PromptDeck, WikipediaRandom, type StimulusPicker } from "./stimuli";

export function createLLM(config: AgoraConfig): LLMClient {
  if (config.useMockLLM) return plausibleMockLLM();
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Falta ANTHROPIC_API_KEY. Defínela, o usa AGORA_USE_MOCK_LLM=1 para trabajar sin red.");
  }
  return new AnthropicLLM();
}

/** Con MockLLM los estímulos salen solo del mazo local, para que el modo mock no dependa de la red. */
export function createStimulusPicker(config: AgoraConfig, store: ForumStore): StimulusPicker {
  const deck = new PromptDeck(store.loadStimuliDeck());
  if (config.useMockLLM) return (rng) => deck.get(rng);
  return mixedPicker(new WikipediaRandom(config.lang), deck);
}
