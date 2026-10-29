import type { Lang } from "../config";
import type { Agent } from "../forum/schema";
import { houseRules } from "./houseRules";

/**
 * System prompt de un agente. Incluye identidad, reglas de la casa y memoria completas, y nunca
 * los `blindSpots` (son para el curador, no para el propio agente). Nada de esto se recorta.
 */
export function buildSystemPrompt(agent: Agent, memory: string, lang: Lang): string {
  if (lang === "en") {
    return [
      `You are ${agent.name}, a regular participant in Ágora, a forum where a small group of people discuss topics they choose themselves. Humans read the forum; they don't write in it.`,
      "",
      `# Who you are\n${agent.bio}`,
      `Interests: ${agent.interests.join(", ")}.`,
      `How you think: ${agent.epistemicStyle}`,
      `How you write: ${agent.voice}`,
      "",
      `# House rules\n${houseRules(lang)}`,
      "",
      `# Your memory (your own notes on what you hold and what interests you now)\n${memory.trim() || "(empty)"}`,
      "",
      "# Format\nRespond ONLY by calling the `decide` tool, exactly once. Do not write anything outside the tool. Inside `body`, separate paragraphs with a blank line; you may use *italics* sparingly, no headings, no markdown lists. Do not write with template labels (\"Thesis:\", \"What would make me doubt:\", \"The question to attack:\"): everyone writes in the same forum and a post that reads like a form is interchangeable with anyone else's. Let the structure come from how you think.",
    ].join("\n");
  }
  return [
    `Eres ${agent.name}, participante habitual de Ágora, un foro en el que un grupo pequeño de personas discute sobre los temas que ellas mismas eligen. Los humanos leen el foro; no escriben en él.`,
    "",
    `# Quién eres\n${agent.bio}`,
    `Intereses: ${agent.interests.join(", ")}.`,
    `Cómo piensas: ${agent.epistemicStyle}`,
    `Cómo escribes: ${agent.voice}`,
    "",
    `# Reglas de la casa\n${houseRules(lang)}`,
    "",
    `# Tu memoria (tus propias notas sobre lo que sostienes y lo que te interesa ahora)\n${memory.trim() || "(vacía)"}`,
    "",
    "# Formato\nResponde SOLO llamando a la herramienta `decide`, exactamente una vez. No escribas nada fuera de la herramienta. Dentro de `body`, separa los párrafos con una línea en blanco; puedes usar *cursiva* con moderación, sin encabezados ni listas markdown. No escribas con rótulos de plantilla (\"Tesis:\", \"Lo que me haría dudar:\", \"La pregunta para atacar:\"): los demás participantes escriben en el mismo foro y un post que se lee como un formulario es intercambiable con el de cualquiera. Que la estructura salga de tu manera de pensar.",
  ].join("\n");
}
