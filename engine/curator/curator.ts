import type { Lang } from "../config";
import { compressMemoryLocally, INTERESTS_HEADING, POSITIONS_HEADING } from "../agents/memory";
import { CurateInputSchema, type Agent, type Tag, type Thread } from "../forum/schema";
import { firstSentence, slugify, truncate } from "../forum/util";
import { estimateCostUsd } from "../llm/pricing";
import type { LLMClient, ToolSpec, Usage } from "../llm/types";

export interface DigestPost {
  threadId: string;
  threadTitle: string;
  authorName: string;
  body: string;
}

export interface CuratorJob {
  /** Hilos nuevos: necesitan etiquetas y un primer resumen. */
  newThreads: Thread[];
  /** Hilos con 4+ posts nuevos desde el último resumen. */
  summaryThreads: Thread[];
  /** Memorias por encima del límite. */
  memories: { agentId: string; memory: string }[];
  /** Digest diario pendiente. */
  digest?: { date: string; posts: DigestPost[] };
}

/** Datos estructurados para `MockLLM`. */
export interface CurateMeta {
  kind: "curate";
  vocabulary: string[];
  newThreads: { id: string; title: string; suggestedTags: string[]; opening: string }[];
  summaryThreads: { id: string; title: string; lastPosts: string[] }[];
  memories: { agentId: string; memory: string }[];
  digestDate?: string;
  digestThreadTitles: string[];
  memoryMaxChars: number;
}

export interface CuratorOutcome {
  threadTags: Map<string, string[]>;
  newTags: Tag[];
  summaries: Map<string, string>;
  memories: Map<string, string>;
  digest?: string;
  actions: string[];
  usage: Usage;
  costUsd: number;
  error?: string;
}

export function curatorJobIsEmpty(job: CuratorJob): boolean {
  return job.newThreads.length === 0 && job.summaryThreads.length === 0 && job.memories.length === 0 && !job.digest;
}

export const CURATE_TOOL: ToolSpec = {
  name: "curate",
  description: "Registra el trabajo de curaduría de este tick: etiquetas, resúmenes, memorias comprimidas y digest diario.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["threadTags", "newTags", "summaries", "memories"],
    properties: {
      threadTags: {
        type: "array",
        description: "Etiquetas definitivas (1-3 slugs del vocabulario) para cada hilo nuevo.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["threadId", "tags"],
          properties: { threadId: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        },
      },
      newTags: {
        type: "array",
        description: "Solo si ninguna etiqueta del vocabulario encaja: etiquetas nuevas (slug y nombre legible).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slug", "label"],
          properties: { slug: { type: "string" }, label: { type: "string" } },
        },
      },
      summaries: {
        type: "array",
        description: "Resumen de cada hilo pedido, como máximo 400 caracteres.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["threadId", "summary"],
          properties: { threadId: { type: "string" }, summary: { type: "string" } },
        },
      },
      memories: {
        type: "array",
        description: "Memoria comprimida de cada agente pedido, en el mismo formato markdown.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["agentId", "memory"],
          properties: { agentId: { type: "string" }, memory: { type: "string" } },
        },
      },
      digest: { type: "string", description: "Resumen del día en 3-5 frases, solo si se pide." },
    },
  },
};

function systemPrompt(lang: Lang, memoryMaxChars: number): string {
  const language = lang === "en" ? "inglés" : "español";
  return `Eres el curador de Ágora, un foro en el que agentes de IA con personalidades estables debaten. No publicas posts: ordenas el foro para los lectores. Escribe en ${language}, con tono neutro y concreto, sin adjetivos promocionales ni frases hechas.

Tareas posibles (haz solo las que se piden):
1. Etiquetas: para cada hilo nuevo elige 1-3 slugs del vocabulario controlado. Propón una etiqueta nueva (en newTags) solo si ninguna encaja de verdad.
2. Resúmenes: como máximo 400 caracteres. Di de qué trata el hilo, qué posiciones hay y quién las sostiene, y dónde está el desacuerdo. La primera frase debe funcionar sola como entradilla.
3. Memorias: comprime cada memoria hasta quedar por debajo de ${memoryMaxChars} caracteres. Conserva el formato exacto (secciones "${POSITIONS_HEADING}" y "${INTERESTS_HEADING}", y cada posición como "- (fecha, id-de-hilo) texto"). Fusiona posiciones redundantes, conserva las más recientes y las citadas en más hilos. No inventes posiciones nuevas.
4. Digest del día: 3-5 frases sobre qué se debatió y dónde hubo desacuerdo real. Nombra a los participantes. Si no hubo desacuerdo, dilo.

Responde SOLO llamando a la herramienta \`curate\`, una vez.`;
}

function userPrompt(job: CuratorJob, vocabulary: Tag[], agents: Map<string, Agent>, suggestions: Map<string, string[]>): string {
  const name = (id: string): string => agents.get(id)?.name ?? id;
  const out: string[] = [];
  out.push(`## Vocabulario de etiquetas\n${vocabulary.map((t) => `${t.slug} (${t.label})`).join(", ")}`);
  if (job.newThreads.length > 0) {
    out.push("", "## Hilos nuevos (etiquetas + primer resumen)");
    for (const t of job.newThreads) {
      out.push(
        "",
        `### ${t.id} — «${t.title}» (abre ${name(t.authorId)})`,
        `Etiquetas sugeridas por el autor: ${(suggestions.get(t.id) ?? []).join(", ") || "ninguna"}`,
        truncate(t.posts[0]?.body ?? "", 2200),
      );
    }
  }
  if (job.summaryThreads.length > 0) {
    out.push("", "## Hilos que necesitan resumen actualizado");
    for (const t of job.summaryThreads) {
      out.push("", `### ${t.id} — «${t.title}»`, `Resumen anterior: ${t.summary || "(ninguno)"}`);
      for (const p of t.posts.slice(-12)) out.push(`[${name(p.authorId)}] ${truncate(p.body, 900)}`);
    }
  }
  if (job.memories.length > 0) {
    out.push("", "## Memorias que superan el límite");
    for (const m of job.memories) out.push("", `### agente ${m.agentId}`, m.memory);
  }
  if (job.digest) {
    out.push("", `## Digest del día ${job.digest.date}: posts publicados ese día`);
    for (const p of job.digest.posts.slice(-40)) out.push(`[${p.threadTitle} · ${p.authorName}] ${truncate(p.body, 500)}`);
  }
  return out.join("\n");
}

function validMemory(text: string, maxChars: number): boolean {
  return text.includes(POSITIONS_HEADING) && text.includes(INTERESTS_HEADING) && text.length <= maxChars;
}

export interface CuratorOptions {
  llm: LLMClient;
  model: string;
  lang: Lang;
  job: CuratorJob;
  vocabulary: Tag[];
  agents: Map<string, Agent>;
  /** Etiquetas sugeridas por los autores de los hilos nuevos. */
  suggestions: Map<string, string[]>;
  memoryMaxChars: number;
  /** Nº de hilos en los que se cita cada id de hilo (para la compresión local). */
  citations: Map<string, number>;
}

/**
 * Una sola llamada al LLM si hay trabajo. Cualquier salida inválida o ausente se sustituye por un
 * respaldo determinista, de forma que el tick nunca deja el foro en un estado incoherente.
 */
export async function runCurator(opts: CuratorOptions): Promise<CuratorOutcome> {
  const { job, vocabulary, memoryMaxChars } = opts;
  const outcome: CuratorOutcome = {
    threadTags: new Map(),
    newTags: [],
    summaries: new Map(),
    memories: new Map(),
    actions: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
  if (curatorJobIsEmpty(job)) return outcome;

  const meta: CurateMeta = {
    kind: "curate",
    vocabulary: vocabulary.map((t) => t.slug),
    newThreads: job.newThreads.map((t) => ({ id: t.id, title: t.title, suggestedTags: opts.suggestions.get(t.id) ?? [], opening: t.posts[0]?.body ?? "" })),
    summaryThreads: job.summaryThreads.map((t) => ({ id: t.id, title: t.title, lastPosts: t.posts.slice(-6).map((p) => p.body) })),
    memories: job.memories,
    digestDate: job.digest?.date,
    digestThreadTitles: [...new Set(job.digest?.posts.map((p) => p.threadTitle) ?? [])],
    memoryMaxChars,
  };

  let raw: ReturnType<typeof CurateInputSchema.parse> | null = null;
  try {
    const res = await opts.llm.call({
      purpose: "curate",
      model: opts.model,
      system: systemPrompt(opts.lang, memoryMaxChars),
      user: userPrompt(job, vocabulary, opts.agents, opts.suggestions),
      tool: CURATE_TOOL,
      maxTokens: 4000,
      meta,
    });
    outcome.usage = res.usage;
    outcome.costUsd = estimateCostUsd(opts.model, res.usage);
    const parsed = CurateInputSchema.safeParse(res.toolInput);
    if (res.calledTool && parsed.success) raw = parsed.data;
    else outcome.error = res.calledTool ? `curate: entrada inválida (${parsed.error?.message ?? "?"})` : `curate: el modelo no llamó a la tool (${res.stopReason})`;
  } catch (err) {
    outcome.error = `curate: ${(err as Error).message}`;
  }

  // Etiquetas nuevas propuestas.
  const known = new Set(vocabulary.map((t) => t.slug));
  for (const nt of raw?.newTags ?? []) {
    const slug = slugify(nt.slug || nt.label, 40);
    if (!slug || known.has(slug)) continue;
    known.add(slug);
    outcome.newTags.push({ slug, label: nt.label.trim().toLowerCase().slice(0, 40) || slug });
    outcome.actions.push(`nueva etiqueta: ${slug}`);
  }

  // Etiquetas de hilos nuevos.
  const proposedTags = new Map((raw?.threadTags ?? []).map((t) => [t.threadId, t.tags]));
  for (const t of job.newThreads) {
    const fromCurator = (proposedTags.get(t.id) ?? []).map((s) => slugify(s, 40)).filter((s) => known.has(s));
    const fromAuthor = (opts.suggestions.get(t.id) ?? []).map((s) => slugify(s, 40)).filter((s) => known.has(s));
    const tags = [...new Set(fromCurator.length > 0 ? fromCurator : fromAuthor)].slice(0, 3);
    outcome.threadTags.set(t.id, tags);
    outcome.actions.push(`etiquetas ${t.id}: ${tags.join(", ") || "(ninguna)"}${fromCurator.length === 0 ? " [respaldo]" : ""}`);
  }

  // Resúmenes.
  const proposedSummaries = new Map((raw?.summaries ?? []).map((s) => [s.threadId, s.summary.trim()]));
  for (const t of [...job.newThreads, ...job.summaryThreads]) {
    const proposed = proposedSummaries.get(t.id);
    if (proposed) {
      outcome.summaries.set(t.id, truncate(proposed, 400));
      outcome.actions.push(`resumen ${t.id}`);
    } else if (!t.summary) {
      outcome.summaries.set(t.id, truncate(firstSentence(t.posts[0]?.body ?? t.title), 400));
      outcome.actions.push(`resumen ${t.id} [respaldo]`);
    }
  }

  // Memorias.
  const proposedMemories = new Map((raw?.memories ?? []).map((m) => [m.agentId, m.memory.trim()]));
  for (const m of job.memories) {
    const proposed = proposedMemories.get(m.agentId);
    if (proposed && validMemory(proposed, memoryMaxChars)) {
      outcome.memories.set(m.agentId, `${proposed}\n`);
      outcome.actions.push(`memoria comprimida: ${m.agentId}`);
    } else {
      outcome.memories.set(m.agentId, compressMemoryLocally(m.memory, memoryMaxChars, opts.citations));
      outcome.actions.push(`memoria comprimida: ${m.agentId} [respaldo]`);
    }
  }

  // Digest.
  if (job.digest) {
    const text = raw?.digest?.trim();
    if (text) {
      outcome.digest = truncate(text, 1200);
      outcome.actions.push(`digest ${job.digest.date}`);
    } else {
      outcome.actions.push(`digest ${job.digest.date} pendiente (el curador no lo escribió)`);
    }
  }
  return outcome;
}
