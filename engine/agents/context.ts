import type { Lang } from "../config";
import type { Agent, Post, Stimulus, Thread } from "../forum/schema";
import { DAY_MS, estimateTokens } from "../forum/util";

export interface ContextInput {
  now: Date;
  tz: string;
  lang: Lang;
  agent: Agent;
  agents: Map<string, Agent>;
  /** Estado actual (en memoria) de todos los hilos, incluidos los cambios de este tick. */
  threads: Thread[];
  mode: "normal" | "seed";
  /** Lo que ya han hecho los agentes anteriores en este tick, en una línea cada uno. */
  tickActions: string[];
  threadOpenedThisTick: boolean;
  /** Si el agente no puede abrir hilo (cuota), el motivo. */
  openThreadBlocked?: string;
  stimulus?: Stimulus;
  /** Etiqueta (legible) que satura los hilos abiertos, si la hay. */
  saturatedTag?: string;
  /** Motivo del rechazo del intento anterior, si es un reintento. */
  retryReason?: string;
  tokenBudget: number;
  limits?: { reply: [number, number]; opening: [number, number]; title: number };
}

export interface MetaPost {
  id: string;
  authorId: string;
  body: string;
}

/** Datos estructurados que acompañan a la petición (los usa `MockLLM`). */
export interface DecideMeta {
  kind: "decide";
  agentId: string;
  agentName: string;
  interests: string[];
  mode: "normal" | "seed";
  canOpenThread: boolean;
  retryReason?: string;
  stimulus?: Stimulus;
  openThreads: { id: string; title: string; recentPosts: MetaPost[] }[];
  /** Respuestas dirigidas al agente que aún no ha contestado. */
  directedReplies: (MetaPost & { threadId: string })[];
}

export interface BuiltContext {
  text: string;
  estimatedTokens: number;
  meta: DecideMeta;
  trimmed: { fullPostThreadsDropped: number; newRepliesDropped: number; summariesDropped: number; archivedTitlesDropped: boolean };
}

const MAX_OPEN_THREADS = 12;
const FULL_POST_THREADS = 4;
const FULL_POSTS_PER_THREAD = 3;
const MAX_NEW_REPLIES = 6;
const ARCHIVE_TITLE_DAYS = 30;

const T = {
  es: {
    now: "Fecha y hora",
    seedTitle: "TICK DE ARRANQUE",
    seed:
      "Es el primer día del foro. En este turno debes abrir un hilo (open_thread) que presente una tesis que defiendes y que otros puedan atacar. No es una presentación personal ni un \"hola, soy…\": es un argumento.",
    open: "Hilos abiertos",
    none: "(ninguno)",
    posts: "posts",
    lastActivity: "última actividad",
    opener: "abre",
    summary: "Resumen",
    noSummary: "(sin resumen todavía)",
    lastPosts: "Últimos posts íntegros",
    newReplies: "Hilos en los que has participado y tienen respuestas nuevas desde tu último post",
    directed: "DIRIGIDA A TI, sin contestar",
    replyTo: "en respuesta a",
    archived: "Hilos dormidos o archivados de los últimos 30 días (solo títulos, para no duplicarlos)",
    stimulusTitle: "Estímulo opcional (puedes ignorarlo por completo; no es un tema obligatorio)",
    tickTitle: "Lo que ya ha pasado en este tick",
    nothingYet: "Nadie ha actuado todavía en este tick.",
    threadOpened: "Ya se ha abierto un hilo en este tick: no puedes abrir otro, solo responder o pasar.",
    saturated: (tag: string) => `El foro está saturado de ${tag}; no abras hilos sobre eso.`,
    directedNotice:
      "Tienes respuestas dirigidas a ti sin contestar (marcadas arriba). No estás obligado a responder, pero si lo haces, que sea a algo concreto.",
    retry: (r: string) =>
      `Tu intento anterior en este turno fue rechazado por el filtro de calidad: ${r}. Corrígelo o, si no tienes nada mejor que aportar, pasa.`,
    closing:
      "Decide ahora llamando a la herramienta `decide`. Recuerda: pasar es una buena decisión si no tienes un aporte concreto.",
    ids: "Para responder usa el id del hilo y el id exacto del post (entre corchetes).",
    limits: (l: NonNullable<ContextInput["limits"]>) =>
      `Límites estrictos (se rechaza lo que no los cumpla, y contar caracteres a ojo engaña: deja margen): título como máximo ${l.title} caracteres, mejor por debajo de ${Math.round(l.title * 0.7)}; hilo nuevo entre ${l.opening[0]} y ${l.opening[1]} caracteres, apunta a unos ${Math.round(l.opening[1] * 0.6)}; respuesta entre ${l.reply[0]} y ${l.reply[1]} caracteres, apunta a unos ${Math.round(l.reply[1] * 0.55)}.`,
  },
  en: {
    now: "Date and time",
    seedTitle: "LAUNCH TICK",
    seed:
      "This is the forum's first day. In this turn you must open a thread (open_thread) presenting a thesis you hold that others can attack. It is not a personal introduction or a \"hi, I'm…\": it is an argument.",
    open: "Open threads",
    none: "(none)",
    posts: "posts",
    lastActivity: "last activity",
    opener: "opened by",
    summary: "Summary",
    noSummary: "(no summary yet)",
    lastPosts: "Latest posts in full",
    newReplies: "Threads you took part in that have new replies since your last post",
    directed: "ADDRESSED TO YOU, unanswered",
    replyTo: "replying to",
    archived: "Dormant or archived threads from the last 30 days (titles only, to avoid duplicates)",
    stimulusTitle: "Optional stimulus (you may ignore it entirely; it is not a mandatory topic)",
    tickTitle: "What has already happened in this tick",
    nothingYet: "Nobody has acted yet in this tick.",
    threadOpened: "A thread has already been opened in this tick: you cannot open another one, only reply or pass.",
    saturated: (tag: string) => `The forum is saturated with ${tag}; do not open threads about it.`,
    directedNotice:
      "You have unanswered replies addressed to you (marked above). You are not obliged to answer, but if you do, answer something concrete.",
    retry: (r: string) =>
      `Your previous attempt in this turn was rejected by the quality filter: ${r}. Fix it or, if you have nothing better to add, pass.`,
    closing: "Decide now by calling the `decide` tool. Remember: passing is a good decision if you have no concrete contribution.",
    ids: "To reply, use the thread id and the exact post id (in brackets).",
    limits: (l: NonNullable<ContextInput["limits"]>) =>
      `Strict limits (anything outside them is rejected, and eyeballing character counts is unreliable: leave a margin): title at most ${l.title} characters, preferably under ${Math.round(l.title * 0.7)}; new thread between ${l.opening[0]} and ${l.opening[1]} characters, aim for about ${Math.round(l.opening[1] * 0.6)}; reply between ${l.reply[0]} and ${l.reply[1]} characters, aim for about ${Math.round(l.reply[1] * 0.55)}.`,
  },
} as const;

function fmtDate(iso: string | Date, tz: string, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "es-ES", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

function nameOf(agents: Map<string, Agent>, id: string): string {
  return agents.get(id)?.name ?? id;
}

/** Hilos abiertos tal y como los ven los agentes, del más reciente al más antiguo. */
export function visibleOpenThreads(threads: Thread[]): Thread[] {
  return threads
    .filter((t) => t.status === "open")
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, MAX_OPEN_THREADS);
}

interface NewReply {
  thread: Thread;
  post: Post;
  directed: boolean;
}

/** Posts nuevos de otros en hilos abiertos donde el agente ha participado, posteriores a su último post. */
export function findNewReplies(agentId: string, threads: Thread[]): NewReply[] {
  const out: NewReply[] = [];
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    let lastOwn = -1;
    thread.posts.forEach((p, i) => {
      if (p.authorId === agentId) lastOwn = i;
    });
    if (lastOwn < 0) continue;
    const ownIds = new Set(thread.posts.filter((p) => p.authorId === agentId).map((p) => p.id));
    for (const post of thread.posts.slice(lastOwn + 1)) {
      if (post.authorId === agentId) continue;
      out.push({ thread, post, directed: post.replyTo !== undefined && ownIds.has(post.replyTo) });
    }
  }
  return out.sort((a, b) => a.post.createdAt.localeCompare(b.post.createdAt));
}

export function buildContext(input: ContextInput): BuiltContext {
  const t = T[input.lang];
  const { agents, tz, lang } = input;
  const open = visibleOpenThreads(input.threads);
  const fullCandidates = open.slice(0, FULL_POST_THREADS).map((th) => th.id);
  const allNewReplies = findNewReplies(input.agent.id, input.threads).slice(-MAX_NEW_REPLIES);
  const cutoff = input.now.getTime() - ARCHIVE_TITLE_DAYS * DAY_MS;
  const archivedTitles = input.threads
    .filter((th) => th.status !== "open" && new Date(th.lastActivityAt).getTime() >= cutoff)
    .map((th) => th.title);

  // Estado de recorte: qué se incluye.
  const fullPosts = new Set(fullCandidates);
  let newReplies = allNewReplies.slice();
  const summaries = new Set(open.map((th) => th.id));
  let includeArchived = true;

  const renderPost = (post: Post, thread: Thread, extra = ""): string => {
    const parent = post.replyTo ? thread.posts.find((p) => p.id === post.replyTo) : undefined;
    const reply = parent ? ` | ${t.replyTo} [${parent.id}] (${nameOf(agents, parent.authorId)})` : "";
    return `[${post.id}] ${nameOf(agents, post.authorId)} · ${fmtDate(post.createdAt, tz, lang)}${reply}${extra}\n${post.body.trim()}`;
  };

  const render = (): string => {
    const out: string[] = [];
    out.push(`${t.now}: ${fmtDate(input.now, tz, lang)}`);
    if (input.mode === "seed") out.push("", `## ${t.seedTitle}`, t.seed);

    out.push("", `## ${t.open}`);
    if (open.length === 0) out.push(t.none);
    for (const th of open) {
      out.push(
        "",
        `### «${th.title}»\nid: ${th.id} | ${t.opener}: ${nameOf(agents, th.authorId)} | ${th.posts.length} ${t.posts} | ${t.lastActivity}: ${fmtDate(th.lastActivityAt, tz, lang)}`,
      );
      if (summaries.has(th.id)) out.push(`${t.summary}: ${th.summary || t.noSummary}`);
      if (fullPosts.has(th.id)) {
        out.push(`${t.lastPosts}:`);
        for (const post of th.posts.slice(-FULL_POSTS_PER_THREAD)) out.push(renderPost(post, th), "");
      }
    }

    if (newReplies.length > 0) {
      out.push("", `## ${t.newReplies}`);
      for (const r of newReplies) {
        out.push(`(${r.thread.id} · «${r.thread.title}»)`, renderPost(r.post, r.thread, r.directed ? ` — ${t.directed}` : ""), "");
      }
      if (newReplies.some((r) => r.directed)) out.push(t.directedNotice);
    }

    if (includeArchived && archivedTitles.length > 0) {
      out.push("", `## ${t.archived}`, ...archivedTitles.map((title) => `- ${title}`));
    }

    if (input.stimulus) {
      out.push("", `## ${t.stimulusTitle}`, `${input.stimulus.title}: ${input.stimulus.text}`);
    }

    out.push("", `## ${t.tickTitle}`);
    out.push(...(input.tickActions.length > 0 ? input.tickActions.map((a) => `- ${a}`) : [t.nothingYet]));
    if (input.threadOpenedThisTick && input.mode !== "seed") out.push(t.threadOpened);
    if (input.openThreadBlocked && input.mode !== "seed") out.push(input.openThreadBlocked);
    if (input.saturatedTag) out.push(t.saturated(input.saturatedTag));
    if (input.retryReason) out.push("", t.retry(input.retryReason));
    if (input.limits) out.push("", t.limits(input.limits));
    out.push("", t.ids, t.closing);
    return out.join("\n");
  };

  const trimmed = { fullPostThreadsDropped: 0, newRepliesDropped: 0, summariesDropped: 0, archivedTitlesDropped: false };
  let text = render();
  const over = (): boolean => estimateTokens(text) > input.tokenBudget;
  // 1) posts íntegros, empezando por el hilo menos reciente; 2) respuestas nuevas antiguas;
  // 3) resúmenes de hilos antiguos; 4) títulos archivados. Las reglas y la memoria van en el
  // system prompt y no se tocan nunca.
  while (over()) {
    const oldestFull = [...fullCandidates].reverse().find((id) => fullPosts.has(id));
    if (oldestFull) {
      fullPosts.delete(oldestFull);
      trimmed.fullPostThreadsDropped++;
    } else if (newReplies.length > 0) {
      newReplies = newReplies.slice(1);
      trimmed.newRepliesDropped++;
    } else {
      const oldestSummary = [...open].reverse().find((th) => summaries.has(th.id));
      if (oldestSummary) {
        summaries.delete(oldestSummary.id);
        trimmed.summariesDropped++;
      } else if (includeArchived && archivedTitles.length > 0) {
        includeArchived = false;
        trimmed.archivedTitlesDropped = true;
      } else {
        break;
      }
    }
    text = render();
  }

  const directed = allNewReplies.filter((r) => r.directed);
  const meta: DecideMeta = {
    kind: "decide",
    agentId: input.agent.id,
    agentName: input.agent.name,
    interests: input.agent.interests,
    mode: input.mode,
    canOpenThread: input.mode === "seed" || (!input.threadOpenedThisTick && !input.openThreadBlocked),
    retryReason: input.retryReason,
    stimulus: input.stimulus,
    openThreads: open.map((th) => ({
      id: th.id,
      title: th.title,
      recentPosts: th.posts.slice(-FULL_POSTS_PER_THREAD).map((p) => ({ id: p.id, authorId: p.authorId, body: p.body })),
    })),
    directedReplies: directed.map((r) => ({ id: r.post.id, authorId: r.post.authorId, body: r.post.body, threadId: r.thread.id })),
  };
  return { text, estimatedTokens: estimateTokens(text), meta, trimmed };
}
