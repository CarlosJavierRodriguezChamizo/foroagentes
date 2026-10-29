import type { Agent, QualityConfig, Tag, Thread } from "../forum/schema";
import { DAY_MS, HOUR_MS, randInt, type Rng } from "../forum/util";

// --- Selección de agentes activos (4.1 paso 3 y 5.3 rotación) -----------------

export interface SelectionInput {
  agents: Agent[];
  rng: Rng;
  min: number;
  max: number;
  /** Agentes que publicaron en los 2 ticks anteriores. */
  recentPosters: Set<string>;
  /** Agentes activos en el tick anterior. */
  prevActive: Set<string>;
  /** Agentes con una respuesta dirigida a ellos sin contestar: tienen prioridad. */
  priority: Set<string>;
}

function weightedPick(candidates: Agent[], rng: Rng): Agent {
  const total = candidates.reduce((s, a) => s + a.activityWeight, 0);
  let r = rng() * total;
  for (const a of candidates) {
    r -= a.activityWeight;
    if (r < 0) return a;
  }
  return candidates[candidates.length - 1] as Agent;
}

/**
 * Muestreo ponderado por `activityWeight`, reproducible con el RNG del tick.
 * - Los agentes con prioridad entran primero (aunque hayan publicado hace poco).
 * - Se excluye a quien publicó en los 2 ticks anteriores.
 * - Nunca repiten los mismos 2 agentes del tick anterior (solape ≤ 1 con él).
 * Si no hay candidatos suficientes para llegar al mínimo, se relajan las restricciones en ese orden.
 */
export function selectActiveAgents(input: SelectionInput): string[] {
  const { agents, rng, recentPosters, prevActive, priority } = input;
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
  const target = Math.min(sorted.length, randInt(rng, input.min, input.max));
  const min = Math.min(sorted.length, input.min);
  const chosen: string[] = [];

  for (const a of sorted) if (priority.has(a.id) && chosen.length < target) chosen.push(a.id);

  const overlapOk = (id: string): boolean => [...chosen, id].filter((x) => prevActive.has(x)).length <= 1;
  const fill = (limit: number, filter: (a: Agent) => boolean): void => {
    while (chosen.length < limit) {
      const candidates = sorted.filter((a) => !chosen.includes(a.id) && filter(a));
      if (candidates.length === 0) return;
      chosen.push(weightedPick(candidates, rng).id);
    }
  };

  fill(target, (a) => !recentPosters.has(a.id) && overlapOk(a.id));
  fill(min, (a) => overlapOk(a.id));
  fill(min, () => true);
  return chosen;
}

// --- Estados de hilo (4.1 paso 7 y 5.3 cierre natural) ------------------------

/** Aplica open → dormant → archived. Devuelve los ids de los hilos que han cambiado. */
export function updateThreadStatuses(threads: Thread[], now: Date, q: QualityConfig): string[] {
  const changed: string[] = [];
  for (const t of threads) {
    const idleMs = now.getTime() - new Date(t.lastActivityAt).getTime();
    let next = t.status;
    if (t.status === "open" && (t.posts.length >= q.dormantAfterPosts || idleMs > q.dormantAfterHours * HOUR_MS)) next = "dormant";
    if (next === "dormant" && idleMs > q.archiveAfterDays * DAY_MS) next = "archived";
    if (next !== t.status) {
      t.status = next;
      changed.push(t.id);
    }
  }
  return changed;
}

// --- Cuotas (5.3) -------------------------------------------------------------

/** Motivo por el que el agente no puede abrir hilo ahora, o undefined si puede. */
export function threadQuotaBlock(agentId: string, threads: Thread[], now: Date, q: QualityConfig): string | undefined {
  const own = threads.filter((t) => t.authorId === agentId).map((t) => new Date(t.createdAt).getTime());
  const lastDay = own.filter((ms) => now.getTime() - ms < DAY_MS).length;
  const lastWeek = own.filter((ms) => now.getTime() - ms < 7 * DAY_MS).length;
  if (lastDay >= q.threadsPerAgentPerDay) return `Ya has abierto ${lastDay} hilo(s) en las últimas 24 h: hoy no puedes abrir otro.`;
  if (lastWeek >= q.threadsPerAgentPerWeek) return `Ya has abierto ${lastWeek} hilos esta semana: no puedes abrir otro todavía.`;
  return undefined;
}

// --- Diversidad de temas (5.3) -------------------------------------------------

/** Etiqueta presente en más del 50 % de los hilos abiertos (si hay al menos 3), o undefined. */
export function saturatedTag(openThreads: Thread[], tags: Tag[]): string | undefined {
  if (openThreads.length < 3) return undefined;
  const counts = new Map<string, number>();
  for (const t of openThreads) for (const tag of new Set(t.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  if (!best || best[1] / openThreads.length <= 0.5) return undefined;
  return tags.find((t) => t.slug === best[0])?.label ?? best[0];
}
