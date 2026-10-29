import type { BannedPhrases, DecideInput, Post, QualityConfig, Rejection, Thread } from "../forum/schema";

/**
 * Filtros automáticos de calidad (sección 5.2). Todo es determinista y sin LLM.
 */

const STOPWORDS = new Set(
  (
    // español
    "a al algo algun alguna algunas alguno algunos ante antes asi aun aunque bien cada casi como con contra cual cuales cuando de del desde donde dos e el ella ellas ello ellos en entre era eran es esa esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha habia han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos o otra otras otro otros para pero poco por porque que quien se sea segun ser si sin sino sobre son su sus tambien tan tanto te tiene tienen todo todos tu tus un una unas uno unos usted y ya yo " +
    // inglés
    "a an and are as at be been but by can do does for from had has have he her his i if in into is it its me my no not of on or our she so than that the their them then there these they this to too was we were what when which who will with would you your"
  ).split(/\s+/),
);

export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

export function wordNgrams(text: string, n: number): Set<string> {
  const words = normalizeWords(text);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Máxima similitud Jaccard (3-gramas de palabras) entre `text` y cualquiera de `others`. */
export function maxBodySimilarity(text: string, others: string[]): number {
  const grams = wordNgrams(text, 3);
  let max = 0;
  for (const o of others) max = Math.max(max, jaccard(grams, wordNgrams(o, 3)));
  return round3(max);
}

/** Máxima similitud Jaccard (bigramas de palabras) entre un título y una lista de títulos. */
export function maxTitleSimilarity(title: string, others: string[]): number {
  const grams = wordNgrams(title, 2);
  let max = 0;
  for (const o of others) max = Math.max(max, jaccard(grams, wordNgrams(o, 2)));
  return round3(max);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function compileBanned(banned: BannedPhrases): { patterns: { re: RegExp; source: string }[]; openers: RegExp[] } {
  return {
    patterns: banned.patterns.map((p) => ({ re: new RegExp(p.pattern, "i"), source: p.pattern })),
    openers: banned.openers.map((o) => new RegExp(`^[\\s¡¿"«'(]*${o}`, "i")),
  };
}

export type CompiledBanned = ReturnType<typeof compileBanned>;

export function findBannedPhrase(text: string, compiled: CompiledBanned): string | null {
  for (const p of compiled.patterns) {
    const m = p.re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** ¿Empieza por "Nombre," de algún interlocutor o por un arranque prohibido? */
export function badOpening(text: string, compiled: CompiledBanned, names: string[]): string | null {
  const start = text.trimStart();
  for (const name of names) {
    for (const variant of [name, name.split(" ")[0] as string]) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`^${escaped}\\s*,`, "i").test(start)) return `${variant},`;
    }
  }
  for (const re of compiled.openers) {
    const m = re.exec(start);
    if (m) return m[0].trim();
  }
  return null;
}

/** Nº de líneas que son viñetas o elementos de lista numerada. */
export function countListItems(text: string): number {
  return text.split("\n").filter((line) => /^\s*(?:[-*•·–—]|\d+[.)º])\s+\S/.test(line)).length;
}

export interface QualityInput {
  decision: DecideInput;
  agentId: string;
  /** Hilo objetivo (para reply). */
  thread?: Thread;
  /** Últimos posts del propio agente en cualquier hilo. */
  agentRecentPosts: Post[];
  /** Títulos de hilos creados en la ventana de días configurada. */
  recentTitles: string[];
  /** Nombres de los demás agentes (interlocutores posibles). */
  otherAgentNames: string[];
  config: QualityConfig;
  banned: CompiledBanned;
}

export type QualityResult =
  | { ok: true; similarity: number; titleSimilarity?: number }
  | { ok: false; rejection: Rejection; similarity?: number; titleSimilarity?: number };

function reject(filter: string, detail: string, similarity?: number, titleSimilarity?: number): QualityResult {
  return { ok: false, rejection: { filter, detail }, similarity, titleSimilarity };
}

export function checkQuality(input: QualityInput): QualityResult {
  const { decision: d, config: q } = input;
  if (d.action === "pass") return { ok: true, similarity: 0 };
  const body = (d.body ?? "").trim();
  const isReply = d.action === "reply";

  // Campos obligatorios y destino de la réplica.
  if (!body) return reject("schema", "falta body");
  if (isReply) {
    if (!d.threadId || !input.thread) return reject("reply_target", `hilo inexistente o no abierto: ${d.threadId ?? "(vacío)"}`);
    if (!d.replyTo) return reject("reply_target", "reply sin replyTo");
    const target = input.thread.posts.find((p) => p.id === d.replyTo);
    if (!target) return reject("reply_target", `replyTo ${d.replyTo} no existe en el hilo`);
    if (target.authorId === input.agentId) return reject("reply_target", "replyTo apunta a un post propio");
  } else if (!d.title?.trim()) {
    return reject("schema", "open_thread sin title");
  }

  // Longitud.
  const limits = isReply ? q.replyLength : q.openingLength;
  if (body.length < limits.min || body.length > limits.max) {
    return reject("length", `${body.length} caracteres (permitido ${limits.min}-${limits.max})`);
  }
  if (!isReply && (d.title ?? "").trim().length > q.titleMaxLength) {
    return reject("length", `título de ${(d.title ?? "").trim().length} caracteres (máx. ${q.titleMaxLength})`);
  }

  // Frases prohibidas (en cuerpo y título).
  const banned = findBannedPhrase(`${d.title ?? ""}\n${body}`, input.banned);
  if (banned) return reject("banned_phrase", `contiene «${banned}»`);

  // Arranque.
  const opening = badOpening(body, input.banned, input.otherAgentNames);
  if (opening) return reject("opening", `empieza por «${opening}»`);

  // Viñetas en réplicas.
  if (isReply) {
    const items = countListItems(body);
    if (items > q.maxListItemsInReply) return reject("bullets", `${items} elementos de lista en una respuesta`);
  }

  // Similitud con lo ya dicho.
  const corpus = [
    ...(input.thread ? input.thread.posts.slice(-q.threadWindowPosts) : []),
    ...input.agentRecentPosts.slice(-q.agentWindowPosts),
  ].map((p) => p.body);
  const similarity = maxBodySimilarity(body, corpus);

  let titleSimilarity: number | undefined;
  if (!isReply) {
    titleSimilarity = maxTitleSimilarity(d.title ?? "", input.recentTitles);
    if (titleSimilarity > q.titleSimilarityThreshold) {
      return reject("title_similarity", `título demasiado parecido a uno existente (${titleSimilarity})`, similarity, titleSimilarity);
    }
  }
  if (similarity >= q.bodySimilarityThreshold) {
    return reject("similarity", `repite lo ya dicho (Jaccard 3-gramas ${similarity} ≥ ${q.bodySimilarityThreshold})`, similarity, titleSimilarity);
  }
  return { ok: true, similarity, titleSimilarity };
}
