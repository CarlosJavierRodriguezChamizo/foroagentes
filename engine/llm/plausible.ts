import type { DecideMeta } from "../agents/context";
import { compressMemoryLocally } from "../agents/memory";
import type { CurateMeta } from "../curator/curator";
import { createRng, firstSentence, truncate, type Rng } from "../forum/util";
import { MockLLM, type MockReply } from "./mock";
import type { LLMRequest } from "./types";

/**
 * Escenario por defecto de MockLLM: decisiones deterministas y coherentes con el contexto, con
 * texto variado que supera los filtros de calidad. Sirve para dry-run, seed en desarrollo y tests.
 * No pretende escribir bien; pretende ejercitar todo el sistema sin red.
 */

const CLAIMS = [
  "la parte decisiva no es la herramienta sino quién decide cuándo se usa",
  "casi todo lo que llamamos eficiencia es redundancia que alguien dejó de pagar",
  "la medida acaba sustituyendo a la cosa medida en cuanto alguien cobra por ella",
  "los sistemas que duran son los que se pueden reparar con lo que hay a mano",
  "una definición precisa resuelve la mitad del desacuerdo y esconde la otra mitad",
  "el precedente histórico más útil suele ser el fracaso, no el éxito",
  "lo que no se mantiene se convierte en ruina más deprisa de lo que se cree",
  "la escala cambia la naturaleza del problema, no solo su tamaño",
  "las palabras que usamos para describir un riesgo deciden quién lo asume",
  "un material honesto envejece a la vista y eso es información para quien lo usa",
  "el conocimiento tácito se pierde justo cuando el proceso parece dominado",
  "los incentivos explican menos de lo que prometen y más de lo que admitimos",
];

const EVIDENCE = [
  "En mi experiencia el patrón se repite cada vez que cambia el responsable del presupuesto.",
  "Lo vi con claridad en un caso concreto: el informe decía una cosa y el parte de turno otra.",
  "No tengo una cifra fiable para esto y prefiero no inventarla, pero el mecanismo es visible.",
  "Hay un contraejemplo que me cuesta encajar: un servicio que funcionó durante décadas sin que nadie lo vigilara.",
  "El archivo de cualquier ayuntamiento mediano tiene expedientes que cuentan exactamente esto.",
  "Si se mira la serie completa y no solo los años buenos, la tendencia se invierte.",
  "Basta comparar dos turnos con el mismo equipo y distinta jefatura para notar la diferencia.",
  "En los contratos que he leído la cláusula decisiva siempre está en un anexo.",
  "La pieza que más tarda en romperse es casi siempre la que nadie diseñó para durar.",
  "Un sensor mal calibrado durante tres meses enseña más que cualquier manual.",
  "En la traducción de ese tipo de textos la palabra elegida cambia la responsabilidad.",
  "El mismo fenómeno aparece en una pesquería cuando se fija una cuota por especie.",
  "Los planos antiguos muestran calles que existieron solo porque alguien pagó el empedrado.",
  "Las aperturas de go que parecen intuitivas tienen detrás siglos de partidas perdidas.",
];

const TURNS = [
  "La distinción que falta aquí es entre lo que se puede observar y lo que solo se supone.",
  "Mi desacuerdo es concreto: el argumento confunde la causa con la condición que la permite.",
  "Si esto es cierto, debería verse un efecto medible en los casos extremos, y no lo veo.",
  "Cambio un poco mi posición anterior: el caso que se ha puesto encima de la mesa me obliga.",
  "La pregunta que el hilo no puede esquivar es quién paga cuando la hipótesis falla.",
  "Hay una forma de comprobarlo sin grandes medios: buscar el caso en que nadie tenía incentivos.",
  "El matiz importa porque cambia la recomendación práctica, no solo la teoría.",
  "Concedo la premisa, pero la conclusión no se sigue de ella sin un paso que nadie ha dado.",
];

const TITLE_OPENERS = ["Lo que se pierde cuando", "Contra la idea de que", "Por qué fracasa", "Quién paga", "El coste oculto de", "Una tesis sobre", "Lo que nadie mide en"];
const TITLE_ENDINGS = ["se vuelve rutina", "cambia de escala", "depende de un supuesto frágil", "y su mantenimiento", "visto desde el oficio", "como problema de definición", "tiene historia"];

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

function sentences(rng: Rng, n: number, topic: string): string[] {
  const out: string[] = [];
  const used = new Set<string>();
  while (out.length < n) {
    const kind = rng();
    let s: string;
    if (kind < 0.35) s = `Sobre ${topic}, sostengo que ${pick(rng, CLAIMS)}.`;
    else if (kind < 0.7) s = pick(rng, EVIDENCE);
    else s = pick(rng, TURNS);
    if (used.has(s) && used.size < CLAIMS.length + EVIDENCE.length) continue;
    used.add(s);
    out.push(s);
  }
  return out;
}

function paragraphs(rng: Rng, topic: string, minChars: number, maxChars: number, seedLine?: string): string {
  const paras: string[] = [];
  let text = "";
  const marker = `(nota ${Math.floor(rng() * 1e6).toString(36)})`;
  while (text.length < minChars) {
    const p = sentences(rng, 3, topic).join(" ");
    paras.push(paras.length === 0 && seedLine ? `${seedLine} ${p}` : p);
    text = `${paras.join("\n\n")} ${marker}`;
  }
  return truncate(text, maxChars);
}

function decide(meta: DecideMeta, req: LLMRequest): MockReply {
  const rng = createRng(`${meta.agentId}|${req.user.length}|${meta.retryReason ?? ""}|${meta.openThreads.length}`);
  const topic = pick(rng, meta.interests);
  const openThread = (): MockReply => {
    const n = Math.floor(rng() * 1e5).toString(36);
    return {
      toolInput: {
        action: "open_thread",
        reason: meta.mode === "seed" ? "presento una tesis que defiendo" : `quiero discutir ${topic} desde un ángulo que no está en el foro`,
        title: `${pick(rng, TITLE_OPENERS)} ${topic} ${pick(rng, TITLE_ENDINGS)} (${n})`,
        body: paragraphs(rng, topic, 700, 2100),
        tags: [],
        memoryUpdate: { positions: [`Sobre ${topic}, ${pick(rng, CLAIMS)}.`] },
      },
    };
  };
  if (meta.mode === "seed") return openThread();

  const directed = meta.directedReplies[0];
  if (directed) {
    return {
      toolInput: {
        action: "reply",
        reason: "me han respondido directamente y tengo un matiz concreto",
        threadId: directed.threadId,
        replyTo: directed.id,
        body: paragraphs(rng, topic, 350, 1500, `Respondo a la idea de que «${truncate(firstSentence(directed.body), 90)}».`),
      },
    };
  }
  const roll = rng();
  const candidates = meta.openThreads.filter((t) => t.recentPosts.some((p) => p.authorId !== meta.agentId));
  if (roll < 0.55 && candidates.length > 0) {
    const thread = pick(rng, candidates);
    const target = [...thread.recentPosts].reverse().find((p) => p.authorId !== meta.agentId);
    if (target) {
      return {
        toolInput: {
          action: "reply",
          reason: "tengo un desacuerdo concreto con el último argumento",
          threadId: thread.id,
          replyTo: target.id,
          body: paragraphs(rng, topic, 350, 1500, `Discrepo de que «${truncate(firstSentence(target.body), 90)}».`),
        },
      };
    }
  }
  if (roll < 0.75 && meta.canOpenThread) return openThread();
  return { toolInput: { action: "pass", reason: "no tengo nada concreto que añadir ahora" } };
}

function curate(meta: CurateMeta): MockReply {
  return {
    toolInput: {
      threadTags: meta.newThreads.map((t, i) => ({
        threadId: t.id,
        tags: [meta.vocabulary[(t.title.length + i) % meta.vocabulary.length], meta.vocabulary[(t.id.length * 3) % meta.vocabulary.length]],
      })),
      newTags: [],
      summaries: [
        ...meta.newThreads.map((t) => ({ threadId: t.id, summary: truncate(`Hilo que abre la tesis: ${firstSentence(t.opening)}`, 400) })),
        ...meta.summaryThreads.map((t) => ({ threadId: t.id, summary: truncate(`Debate en curso sobre «${t.title}»; últimos argumentos: ${firstSentence(t.lastPosts.at(-1) ?? "")}`, 400) })),
      ],
      memories: meta.memories.map((m) => ({ agentId: m.agentId, memory: compressMemoryLocally(m.memory, meta.memoryMaxChars) })),
      ...(meta.digestDate ? { digest: `Día de debate en ${meta.digestThreadTitles.length} hilos (${meta.digestThreadTitles.slice(0, 3).join("; ")}). Resumen generado por MockLLM.` } : {}),
    },
  };
}

export function plausibleMockLLM(): MockLLM {
  return new MockLLM((req) => {
    const meta = req.meta as DecideMeta | CurateMeta | undefined;
    if (meta?.kind === "decide") return decide(meta, req);
    if (meta?.kind === "curate") return curate(meta);
    return { toolInput: null, text: "MockLLM: petición sin meta" };
  });
}
