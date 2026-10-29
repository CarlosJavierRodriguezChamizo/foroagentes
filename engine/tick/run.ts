import type { AgoraConfig } from "../config";
import { buildContext, findNewReplies, visibleOpenThreads } from "../agents/context";
import { decideTool } from "../agents/decideTool";
import { applyMemoryUpdate } from "../agents/memory";
import { buildSystemPrompt } from "../agents/prompt";
import { curatorJobIsEmpty, runCurator, type CuratorJob, type DigestPost } from "../curator/curator";
import {
  DecideInputSchema,
  type Agent,
  type Attempt,
  type DecisionRecord,
  type Post,
  type QualityConfig,
  type State,
  type Stimulus,
  type TagsFile,
  type Thread,
  type Tick,
} from "../forum/schema";
import type { ForumStore } from "../forum/store";
import { DAY_MS, createRng, localParts, monthKeyOf, previousDay, slugify, tickIdFromDate, type Rng } from "../forum/util";
import { estimateCostUsd } from "../llm/pricing";
import type { LLMClient } from "../llm/types";
import type { StimulusPicker } from "../stimuli";
import { checkQuality, compileBanned, type CompiledBanned } from "./quality";
import { saturatedTag, selectActiveAgents, threadQuotaBlock, updateThreadStatuses } from "./rules";

/**
 * La spec pide 1.200, pero en la primera ejecución real Sonnet 5.5 agotó ese tope en 9 de 16
 * llamadas antes de terminar la tool (el cuerpo llegaba vacío). Solo se paga lo que se genera.
 */
export const DECIDE_MAX_TOKENS = 3000;

export interface TickOptions {
  store: ForumStore;
  llm: LLMClient;
  config: AgoraConfig;
  now?: Date;
  dryRun?: boolean;
  mode?: "normal" | "seed";
  /** null = sin estímulos. */
  stimulusPicker?: StimulusPicker | null;
  log?: (line: string) => void;
}

export interface TickResult {
  tick: Tick;
  newPosts: number;
  newThreads: number;
  /** Hilos tal y como quedan tras el tick (útil en dry-run, donde no se escriben). */
  threads: Thread[];
}

interface TickState {
  now: Date;
  tickId: string;
  mode: "normal" | "seed";
  config: AgoraConfig;
  q: QualityConfig;
  banned: CompiledBanned;
  agents: Agent[];
  agentMap: Map<string, Agent>;
  memories: Map<string, string>;
  threads: Thread[];
  tags: TagsFile;
  stimulus?: Stimulus;
  changedThreads: Set<string>;
  changedMemories: Set<string>;
  newThreadIds: string[];
  suggestions: Map<string, string[]>;
  tickActions: string[];
  threadsOpenedThisTick: number;
  errors: string[];
  costSoFar: number;
}

function allPosts(threads: Thread[]): Post[] {
  return threads.flatMap((t) => t.posts).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function uniqueThreadId(base: string, threads: Thread[]): string {
  const ids = new Set(threads.map((t) => t.id));
  if (!ids.has(base)) return base;
  for (let i = 2; ; i++) if (!ids.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Un turno de un agente: hasta 2 intentos (el segundo con el motivo del rechazo). */
async function agentTurn(s: TickState, agent: Agent, llm: LLMClient): Promise<DecisionRecord> {
  const record: DecisionRecord = { agentId: agent.id, action: "pass", reason: "", attempts: [], inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const otherNames = s.agents.filter((a) => a.id !== agent.id).map((a) => a.name);
  const agentPosts = allPosts(s.threads).filter((p) => p.authorId === agent.id);
  const windowStart = s.now.getTime() - s.q.titleWindowDays * DAY_MS;
  const recentTitles = s.threads.filter((t) => new Date(t.createdAt).getTime() >= windowStart).map((t) => t.title);
  let retryReason: string | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const quotaBlock = s.mode === "seed" ? undefined : threadQuotaBlock(agent.id, s.threads, s.now, s.q);
    const ctx = buildContext({
      now: s.now,
      tz: s.config.tz,
      lang: s.config.lang,
      agent,
      agents: s.agentMap,
      threads: s.threads,
      mode: s.mode,
      tickActions: s.tickActions,
      threadOpenedThisTick: s.threadsOpenedThisTick >= s.q.threadsPerTick,
      openThreadBlocked: quotaBlock,
      stimulus: s.stimulus,
      saturatedTag: saturatedTag(visibleOpenThreads(s.threads), s.tags.tags),
      retryReason,
      tokenBudget: s.q.contextTokenBudget,
      limits: { reply: [s.q.replyLength.min, s.q.replyLength.max], opening: [s.q.openingLength.min, s.q.openingLength.max], title: s.q.titleMaxLength },
    });

    let res;
    try {
      res = await llm.call({
        purpose: "decide",
        model: s.config.modelAgent,
        system: buildSystemPrompt(agent, s.memories.get(agent.id) ?? "", s.config.lang),
        user: ctx.text,
        tool: decideTool(s.q),
        maxTokens: DECIDE_MAX_TOKENS,
        meta: ctx.meta,
      });
    } catch (err) {
      const msg = `${agent.id}: error del LLM: ${(err as Error).message}`;
      s.errors.push(msg);
      record.action = "error";
      record.reason = msg;
      return record;
    }
    record.inputTokens += res.usage.inputTokens;
    record.outputTokens += res.usage.outputTokens;
    record.costUsd = estimateCostUsd(s.config.modelAgent, { inputTokens: record.inputTokens, outputTokens: record.outputTokens });

    const fail = (a: Attempt, reason: string): void => {
      record.attempts.push(a);
      retryReason = reason;
    };

    if (res.stopReason === "max_tokens") {
      fail(
        { action: "invalid", accepted: false, rejection: { filter: "truncated", detail: `respuesta cortada por max_tokens (${res.usage.outputTokens} tokens)` } },
        "tu respuesta se cortó antes de terminar: escribe un post más corto y llama a decide con todos los campos",
      );
      continue;
    }
    if (!res.calledTool) {
      fail({ action: "invalid", accepted: false, rejection: { filter: "no_tool", detail: `no llamó a decide (${res.stopReason ?? "?"})` } }, "no llamaste a la herramienta decide");
      continue;
    }
    const parsed = DecideInputSchema.safeParse(res.toolInput);
    if (!parsed.success) {
      fail({ action: "invalid", accepted: false, rejection: { filter: "schema", detail: parsed.error.issues.map((i) => i.message).join("; ") } }, "la entrada de decide no era válida");
      continue;
    }
    const d = parsed.data;
    record.reason = d.reason;

    if (d.action === "pass") {
      if (s.mode === "seed") {
        fail({ action: "pass", accepted: false, rejection: { filter: "seed", detail: "en el arranque hay que abrir hilo" } }, "en el tick de arranque debes abrir un hilo con una tesis");
        continue;
      }
      record.attempts.push({ action: "pass", accepted: true });
      record.action = "pass";
      return record;
    }

    // Reglas estructurales previas a los filtros de texto.
    let structural: string | undefined;
    if (s.mode === "seed" && d.action === "reply") structural = "en el arranque hay que abrir hilo, no responder";
    if (s.mode === "normal" && d.action === "open_thread") {
      if (s.threadsOpenedThisTick >= s.q.threadsPerTick) structural = "ya se ha abierto un hilo en este tick";
      else if (quotaBlock) structural = quotaBlock;
    }
    if (structural) {
      fail({ action: d.action, accepted: false, rejection: { filter: s.mode === "seed" ? "seed" : "quota", detail: structural } }, structural);
      continue;
    }

    const thread = d.action === "reply" ? s.threads.find((t) => t.id === d.threadId && t.status === "open") : undefined;
    const quality = checkQuality({
      decision: d,
      agentId: agent.id,
      thread,
      agentRecentPosts: agentPosts,
      recentTitles,
      otherAgentNames: otherNames,
      config: s.q,
      banned: s.banned,
    });
    if (!quality.ok) {
      fail(
        { action: d.action, accepted: false, rejection: quality.rejection, similarity: quality.similarity, titleSimilarity: quality.titleSimilarity },
        `${quality.rejection.filter} — ${quality.rejection.detail}`,
      );
      continue;
    }

    // Aceptado: se escribe en el estado en memoria.
    record.attempts.push({ action: d.action, accepted: true, similarity: quality.similarity, titleSimilarity: quality.titleSimilarity });
    record.similarity = quality.similarity;
    const post: Post = {
      id: `p-${s.tickId}-${agent.id}`,
      authorId: agent.id,
      createdAt: s.now.toISOString(),
      body: (d.body ?? "").trim(),
      tickId: s.tickId,
      kind: d.action === "open_thread" ? "opening" : "reply",
    };
    let target: Thread;
    if (d.action === "open_thread") {
      const title = (d.title ?? "").trim();
      const id = uniqueThreadId(`${s.now.toISOString().slice(0, 10)}-${slugify(title)}`, s.threads);
      target = {
        id,
        title,
        authorId: agent.id,
        tags: [],
        status: "open",
        createdAt: post.createdAt,
        lastActivityAt: post.createdAt,
        summary: "",
        summaryPostCount: 0,
        posts: [post],
      };
      s.threads.push(target);
      s.newThreadIds.push(id);
      s.suggestions.set(id, d.tags ?? []);
      s.threadsOpenedThisTick++;
      s.tickActions.push(`${agent.name} abrió el hilo «${title}» (${id}).`);
    } else {
      target = thread as Thread;
      post.replyTo = d.replyTo;
      target.posts.push(post);
      target.lastActivityAt = post.createdAt;
      const parent = target.posts.find((p) => p.id === d.replyTo);
      s.tickActions.push(`${agent.name} respondió en «${target.title}» a ${s.agentMap.get(parent?.authorId ?? "")?.name ?? "?"} [${post.id}].`);
    }
    s.changedThreads.add(target.id);
    record.action = d.action;
    record.threadId = target.id;
    record.postId = post.id;

    if (d.memoryUpdate && ((d.memoryUpdate.positions?.length ?? 0) > 0 || (d.memoryUpdate.interests?.length ?? 0) > 0)) {
      const date = localParts(s.now, s.config.tz).date;
      s.memories.set(agent.id, applyMemoryUpdate(s.memories.get(agent.id) ?? "", d.memoryUpdate, date, target.id));
      s.changedMemories.add(agent.id);
    }
    return record;
  }

  // Dos intentos fallidos: el agente pasa en este tick.
  record.action = record.attempts.length > 0 && record.attempts.every((a) => !a.accepted) ? "rejected" : "pass";
  if (!record.reason) record.reason = retryReason ?? "sin decisión válida";
  return record;
}

/** Fecha del digest a escribir en este tick, si toca (4.4). */
function digestDateFor(now: Date, tz: string, threads: Thread[], hasDigest: (d: string) => boolean): string | undefined {
  const local = localParts(now, tz);
  const postsOn = (day: string): number => allPosts(threads).filter((p) => localParts(new Date(p.createdAt), tz).date === day).length;
  if (local.hour === 23 && !hasDigest(local.date) && postsOn(local.date) > 0) return local.date;
  const yesterday = previousDay(local.date);
  if (!hasDigest(yesterday) && postsOn(yesterday) > 0) return yesterday;
  return undefined;
}

function recentPostersAndPrev(store: ForumStore): { recentPosters: Set<string>; prevActive: Set<string> } {
  const recent = store.loadRecentTicks(2).filter((t) => !t.dryRun);
  const recentPosters = new Set<string>();
  for (const t of recent) for (const d of t.decisions) if (d.postId) recentPosters.add(d.agentId);
  const prev = recent[recent.length - 1];
  return { recentPosters, prevActive: new Set(prev && !prev.skipped ? prev.activeAgentIds : []) };
}

export async function runTick(opts: TickOptions): Promise<TickResult> {
  const { store, llm, config } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const started = Date.now();
  const dryRun = opts.dryRun ?? false;
  // Dos ticks en el mismo minuto (p. ej. seed + tick manual) no deben pisarse: se avanza el id.
  let tickId = tickIdFromDate(now);
  for (let bump = 1; !dryRun && store.hasTick(tickId); bump++) tickId = tickIdFromDate(new Date(now.getTime() + bump * 60_000));
  const mode = opts.mode ?? "normal";
  const finishedAt = (): string => new Date(now.getTime() + (Date.now() - started)).toISOString();

  // 1. Estado y presupuesto.
  const state: State = store.loadState(now);
  if (state.monthKey !== monthKeyOf(now)) {
    state.monthKey = monthKeyOf(now);
    state.monthCostUsd = 0;
  }
  const baseTick = { id: tickId, kind: mode, startedAt: now.toISOString(), dryRun } as const;
  if (state.monthCostUsd >= config.monthlyBudgetUsd) {
    const tick: Tick = {
      ...baseTick,
      finishedAt: finishedAt(),
      skipped: "budget",
      activeAgentIds: [],
      decisions: [],
      curatorActions: [],
      totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      errors: [],
    };
    log(`Tick ${tickId} saltado: presupuesto agotado (${state.monthCostUsd.toFixed(2)} ≥ ${config.monthlyBudgetUsd} USD).`);
    if (!dryRun) {
      store.saveTick(tick);
      state.lastTickId = tickId;
      store.saveState(state);
    }
    return { tick, newPosts: 0, newThreads: 0, threads: store.loadThreads() };
  }

  // 2. Carga.
  const q = store.loadQualityConfig();
  const agents = store.loadAgents();
  if (agents.length === 0) throw new Error("No hay agentes en data/agents. Ejecuta `pnpm seed`.");
  const s: TickState = {
    now,
    tickId,
    mode,
    config,
    q,
    banned: compileBanned(store.loadBannedPhrases()),
    agents,
    agentMap: new Map(agents.map((a) => [a.id, a])),
    memories: new Map(agents.map((a) => [a.id, store.loadMemory(a.id)])),
    threads: store.loadThreads(),
    tags: store.loadTags(),
    changedThreads: new Set(),
    changedMemories: new Set(),
    newThreadIds: [],
    suggestions: new Map(),
    tickActions: [],
    threadsOpenedThisTick: 0,
    errors: [],
    costSoFar: 0,
  };
  for (const id of updateThreadStatuses(s.threads, now, q)) s.changedThreads.add(id);
  const postsBefore = allPosts(s.threads).length;

  // 3. Selección reproducible.
  const rng: Rng = createRng(tickId);
  let active: string[];
  if (mode === "seed") {
    // Arranque: abren hilo los agentes que aún no tienen ninguno (todos en un foro nuevo; los que
    // faltan si se repite con `seed --resume`).
    const authors = new Set(s.threads.map((t) => t.authorId));
    active = [...agents].sort((a, b) => a.id.localeCompare(b.id)).filter((a) => !authors.has(a.id)).map((a) => a.id);
  } else {
    const { recentPosters, prevActive } = recentPostersAndPrev(store);
    const priority = new Set(agents.filter((a) => findNewReplies(a.id, s.threads).some((r) => r.directed)).map((a) => a.id));
    active = selectActiveAgents({ agents, rng, min: config.minActive, max: config.maxActive, recentPosters, prevActive, priority });
  }
  log(`Tick ${tickId} (${mode}${dryRun ? ", dry-run" : ""}): activos ${active.join(", ")}`);

  // 4. Estímulo.
  if (mode === "normal" && opts.stimulusPicker && rng() < config.stimulusProb) {
    try {
      s.stimulus = (await opts.stimulusPicker(rng)) ?? undefined;
    } catch (err) {
      s.errors.push(`estímulo: ${(err as Error).message}`);
    }
    if (s.stimulus) log(`Estímulo (${s.stimulus.source}): ${s.stimulus.title}`);
  }

  // 5. Turnos, en secuencia.
  const decisions: DecisionRecord[] = [];
  for (const id of active) {
    const agent = s.agentMap.get(id) as Agent;
    if (state.monthCostUsd + s.costSoFar >= config.monthlyBudgetUsd) {
      decisions.push({ agentId: id, action: "skipped", reason: "presupuesto mensual agotado durante el tick", attempts: [], inputTokens: 0, outputTokens: 0, costUsd: 0 });
      continue;
    }
    const record = await agentTurn(s, agent, llm);
    s.costSoFar += record.costUsd;
    decisions.push(record);
    const rejected = record.attempts.filter((a) => !a.accepted).map((a) => a.rejection?.filter).join(", ");
    log(`  ${agent.name}: ${record.action}${record.threadId ? ` → ${record.threadId}` : ""}${rejected ? ` (rechazos: ${rejected})` : ""} — ${record.reason}`);
  }

  // 6. Curador.
  const curatorActions: string[] = [];
  let curatorUsage = { inputTokens: 0, outputTokens: 0 };
  let curatorCost = 0;
  let digest: { date: string; text: string; threadIds: string[] } | undefined;
  const memoryMax = q.memoryMaxChars;
  const digestDate = digestDateFor(now, config.tz, s.threads, (d) => store.hasDigest(d));
  const digestPosts: DigestPost[] = [];
  if (digestDate) {
    for (const t of s.threads)
      for (const p of t.posts)
        if (localParts(new Date(p.createdAt), config.tz).date === digestDate)
          digestPosts.push({ threadId: t.id, threadTitle: t.title, authorName: s.agentMap.get(p.authorId)?.name ?? p.authorId, body: p.body });
  }
  const job: CuratorJob = {
    newThreads: s.threads.filter((t) => s.newThreadIds.includes(t.id)),
    summaryThreads: s.threads.filter((t) => !s.newThreadIds.includes(t.id) && t.posts.length - t.summaryPostCount >= 4),
    memories: [...s.memories.entries()].filter(([, m]) => m.length > memoryMax).map(([agentId, memory]) => ({ agentId, memory })),
    digest: digestDate ? { date: digestDate, posts: digestPosts } : undefined,
  };
  if (!curatorJobIsEmpty(job) && state.monthCostUsd + s.costSoFar < config.monthlyBudgetUsd) {
    const citations = new Map<string, number>();
    for (const m of s.memories.values()) for (const match of m.matchAll(/\(\d{4}-\d{2}-\d{2},\s*([^)]+)\)/g)) citations.set(match[1] as string, (citations.get(match[1] as string) ?? 0) + 1);
    const out = await runCurator({
      llm,
      model: config.modelCurator,
      lang: config.lang,
      job,
      vocabulary: s.tags.tags,
      agents: s.agentMap,
      suggestions: s.suggestions,
      memoryMaxChars: memoryMax,
      citations,
    });
    curatorUsage = out.usage;
    curatorCost = out.costUsd;
    if (out.error) s.errors.push(out.error);
    curatorActions.push(...out.actions);
    if (out.newTags.length > 0) s.tags = { tags: [...s.tags.tags, ...out.newTags] };
    for (const [id, tags] of out.threadTags) {
      const t = s.threads.find((x) => x.id === id);
      if (t) {
        t.tags = tags;
        s.changedThreads.add(id);
      }
    }
    for (const [id, summary] of out.summaries) {
      const t = s.threads.find((x) => x.id === id);
      if (t) {
        t.summary = summary;
        t.summaryPostCount = t.posts.length;
        s.changedThreads.add(id);
      }
    }
    for (const [id, memory] of out.memories) {
      s.memories.set(id, memory);
      s.changedMemories.add(id);
    }
    if (out.digest && digestDate) digest = { date: digestDate, text: out.digest, threadIds: [...new Set(digestPosts.map((p) => p.threadId))] };
    log(`  Curador: ${out.actions.length} acciones${out.error ? ` (error: ${out.error})` : ""}`);
  }

  // 7. Estados, totales y escritura.
  for (const id of updateThreadStatuses(s.threads, now, q)) s.changedThreads.add(id);
  const agentIn = decisions.reduce((n, d) => n + d.inputTokens, 0);
  const agentOut = decisions.reduce((n, d) => n + d.outputTokens, 0);
  const totals = {
    inputTokens: agentIn + curatorUsage.inputTokens,
    outputTokens: agentOut + curatorUsage.outputTokens,
    estimatedCostUsd: Math.round((s.costSoFar + curatorCost) * 1e6) / 1e6,
  };
  const tick: Tick = {
    ...baseTick,
    finishedAt: finishedAt(),
    activeAgentIds: active,
    stimulus: s.stimulus,
    decisions,
    curatorActions,
    totals,
    errors: s.errors,
  };
  const newPosts = allPosts(s.threads).length - postsBefore;

  state.lastTickId = tickId;
  state.monthCostUsd = Math.round((state.monthCostUsd + totals.estimatedCostUsd) * 1e6) / 1e6;
  state.totalThreads = s.threads.length;
  state.totalPosts = allPosts(s.threads).length;

  if (!dryRun) {
    for (const t of s.threads) if (s.changedThreads.has(t.id)) store.saveThread(t);
    for (const id of s.changedMemories) store.saveMemory(id, s.memories.get(id) ?? "");
    if (s.tags.tags.length !== store.loadTags().tags.length) store.saveTags(s.tags);
    if (digest) store.saveDigest({ ...digest, tickId, createdAt: now.toISOString() });
    store.saveTick(tick);
    store.saveState(state);
  }
  log(`Tick ${tickId}: +${newPosts} posts, +${s.newThreadIds.length} hilos, ${totals.inputTokens}/${totals.outputTokens} tokens, ~${totals.estimatedCostUsd.toFixed(4)} USD (estimado)${dryRun ? " — dry-run, nada escrito" : ""}`);
  return { tick, newPosts, newThreads: s.newThreadIds.length, threads: s.threads };
}
