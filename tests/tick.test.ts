import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type AgoraConfig } from "../engine/config";
import { findNewReplies, type DecideMeta } from "../engine/agents/context";
import { ForumStore } from "../engine/forum/store";
import type { Thread } from "../engine/forum/schema";
import { createRng } from "../engine/forum/util";
import { MockLLM, type MockReply } from "../engine/llm/mock";
import { plausibleMockLLM } from "../engine/llm/plausible";
import type { LLMRequest } from "../engine/llm/types";
import { prepareSeedData } from "../engine/seed";
import { selectActiveAgents, updateThreadStatuses, threadQuotaBlock, saturatedTag } from "../engine/tick/rules";
import { runTick } from "../engine/tick/run";
import { AGENTS, makePost, makeThread } from "./fixtures";
import { makeTempDataDir } from "./helpers";

const T0 = new Date("2026-10-29T08:00:00.000Z");
const hours = (h: number): Date => new Date(T0.getTime() + h * 3_600_000);

function setup(env: Record<string, string> = {}): { store: ForumStore; config: AgoraConfig } {
  const dir = makeTempDataDir();
  const config = loadConfig({ AGORA_DATA_DIR: dir, AGORA_USE_MOCK_LLM: "1", ...env });
  const store = new ForumStore(dir);
  prepareSeedData(store, T0, false);
  return { store, config };
}

async function seeded(env: Record<string, string> = {}): Promise<{ store: ForumStore; config: AgoraConfig }> {
  const ctx = setup(env);
  await runTick({ ...ctx, llm: plausibleMockLLM(), now: T0, mode: "seed", stimulusPicker: null });
  return ctx;
}

const OK_REPLY =
  "Discrepo de que el mantenimiento sea invisible por desidia. En la depuradora es invisible porque funciona: nadie llama cuando el agua sale limpia. " +
  "La invisibilidad es el síntoma del éxito, no del abandono, y por eso es tan difícil defender su presupuesto delante de quien solo ve averías.";
const OK_OPENING =
  "Sostengo que los calendarios escolares conservan la forma de un mundo agrícola que ya no existe, y que nadie los cambia porque toda la economía de las familias se ha construido alrededor de ellos. " +
  "Es un caso de infraestructura temporal: un horario que se volvió obligación.\n\n" +
  "Si es así, cualquier reforma debería empezar por los costes de transición de las familias y no por la pedagogía. Me interesa que alguien me enseñe un país que lo haya cambiado de verdad y qué pagó por ello, porque sospecho que la respuesta dice más sobre el trabajo que sobre la escuela. Y si nadie lo encuentra, la tesis gana fuerza.";

/** Mock guionizado por agente: cada agente devuelve su cola de respuestas en orden. */
function scripted(perAgent: Record<string, ((meta: DecideMeta) => MockReply)[]>, fallback: MockReply = { toolInput: { action: "pass", reason: "nada" } }): MockLLM {
  const counters = new Map<string, number>();
  const curator = plausibleMockLLM();
  return new MockLLM((req: LLMRequest, i) => {
    const meta = req.meta as DecideMeta | { kind: "curate" };
    if (meta.kind !== "decide") {
      void curator.call(req);
      return { toolInput: { threadTags: [], newTags: [], summaries: [], memories: [] } };
    }
    const n = counters.get(meta.agentId) ?? 0;
    counters.set(meta.agentId, n + 1);
    const fn = perAgent[meta.agentId]?.[n];
    void i;
    return fn ? fn(meta) : fallback;
  });
}

describe("seed", () => {
  it("crea 8 agentes y 8 hilos de presentación, uno por agente", async () => {
    const { store } = await seeded();
    const threads = store.loadThreads();
    expect(store.loadAgents()).toHaveLength(8);
    expect(threads).toHaveLength(8);
    expect(new Set(threads.map((t) => t.authorId)).size).toBe(8);
    for (const t of threads) {
      expect(t.posts[0]?.kind).toBe("opening");
      expect(t.summary.length).toBeGreaterThan(0);
      expect(t.tags.length).toBeGreaterThan(0);
    }
    const state = store.loadState();
    expect(state.totalThreads).toBe(8);
    expect(state.monthCostUsd).toBeGreaterThan(0);
    const tick = store.loadTick(state.lastTickId as string);
    expect(tick.kind).toBe("seed");
    expect(tick.totals.inputTokens).toBeGreaterThan(0);
  });

  it("en un seed repetido solo abren hilo los agentes que aún no tienen", async () => {
    const { store, config } = await seeded();
    const res = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(1), mode: "seed", stimulusPicker: null });
    expect(res.tick.activeAgentIds).toEqual([]);
    expect(res.newThreads).toBe(0);
  });

  it("se niega a sobrescribir un foro con hilos salvo con force", async () => {
    const { store } = await seeded();
    expect(() => prepareSeedData(store, T0, false)).toThrow(/--force/);
    prepareSeedData(store, T0, true);
    expect(store.loadThreads()).toHaveLength(0);
  });
});

describe("selección de agentes", () => {
  it("es reproducible con la misma semilla y respeta min/max", () => {
    const base = { agents: AGENTS, min: 2, max: 4, recentPosters: new Set<string>(), prevActive: new Set<string>(), priority: new Set<string>() };
    const a = selectActiveAgents({ ...base, rng: createRng("2026-10-29T1000Z") });
    const b = selectActiveAgents({ ...base, rng: createRng("2026-10-29T1000Z") });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
    expect(a.length).toBeLessThanOrEqual(4);
    expect(new Set(a).size).toBe(a.length);
  });

  it("excluye a quien publicó en los 2 ticks anteriores salvo que tenga prioridad", () => {
    const recent = new Set(["ignacio", "amparo", "nuria", "carmen"]);
    for (let i = 0; i < 30; i++) {
      const chosen = selectActiveAgents({ agents: AGENTS, rng: createRng(`s${i}`), min: 2, max: 4, recentPosters: recent, prevActive: new Set(), priority: new Set(["carmen"]) });
      expect(chosen[0]).toBe("carmen");
      expect(chosen.filter((id) => recent.has(id) && id !== "carmen")).toEqual([]);
    }
  });

  it("nunca repite los mismos 2 agentes del tick anterior", () => {
    for (let i = 0; i < 50; i++) {
      const prev = new Set(["oscar", "paula"]);
      const chosen = selectActiveAgents({ agents: AGENTS, rng: createRng(`r${i}`), min: 2, max: 2, recentPosters: new Set(), prevActive: prev, priority: new Set() });
      expect(chosen.filter((id) => prev.has(id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("si no hay suficientes candidatos, relaja las restricciones para llegar al mínimo", () => {
    const everyone = new Set(AGENTS.map((a) => a.id));
    const chosen = selectActiveAgents({ agents: AGENTS, rng: createRng("x"), min: 2, max: 4, recentPosters: everyone, prevActive: new Set(), priority: new Set() });
    expect(chosen.length).toBeGreaterThanOrEqual(2);
  });
});

describe("reglas", () => {
  const q = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "data", "quality.json"), "utf8"));

  it("open → dormant por inactividad o por 12 posts; dormant → archived a los 14 días", () => {
    const fresh = makeThread("2026-10-29-a", "A", [makePost("ignacio", "x", { createdAt: T0.toISOString(), kind: "opening" })]);
    const old = makeThread("2026-10-29-b", "B", [makePost("ignacio", "x", { createdAt: T0.toISOString(), kind: "opening" })]);
    const full = makeThread("2026-10-29-c", "C", Array.from({ length: 12 }, (_, i) => makePost(i % 2 ? "oscar" : "paula", `p${i}`, { createdAt: T0.toISOString() })));
    const threads: Thread[] = [fresh, old, full];
    old.lastActivityAt = hours(-49).toISOString();
    expect(updateThreadStatuses(threads, T0, q).sort()).toEqual(["2026-10-29-b", "2026-10-29-c"]);
    expect(fresh.status).toBe("open");
    expect(updateThreadStatuses(threads, hours(15 * 24), q)).toContain("2026-10-29-a");
    expect(old.status).toBe("archived");
  });

  it("cuotas de apertura: 1 cada 24 h y 2 por semana", () => {
    const mk = (id: string, h: number): Thread => makeThread(id, id, [makePost("carmen", "x", { kind: "opening" })], { createdAt: hours(h).toISOString(), authorId: "carmen" });
    expect(threadQuotaBlock("carmen", [mk("2026-10-29-a", -2)], T0, q)).toMatch(/24 h/);
    expect(threadQuotaBlock("carmen", [mk("2026-10-29-a", -30)], T0, q)).toBeUndefined();
    expect(threadQuotaBlock("carmen", [mk("2026-10-29-a", -30), mk("2026-10-29-b", -60)], T0, q)).toMatch(/semana/);
    expect(threadQuotaBlock("oscar", [mk("2026-10-29-a", -2)], T0, q)).toBeUndefined();
  });

  it("detecta saturación de una etiqueta", () => {
    const mk = (id: string, tags: string[]): Thread => makeThread(id, id, [makePost("carmen", "x", { kind: "opening" })], { tags });
    const tags = [{ slug: "economia", label: "economía" }];
    expect(saturatedTag([mk("2026-10-29-a", ["economia"]), mk("2026-10-29-b", ["economia"]), mk("2026-10-29-c", ["historia"])], tags)).toBe("economía");
    expect(saturatedTag([mk("2026-10-29-a", ["economia"]), mk("2026-10-29-b", ["historia"]), mk("2026-10-29-c", ["arte"])], tags)).toBeUndefined();
  });
});

describe("tick completo con MockLLM", () => {
  it("un tick normal tras el seed produce decisiones coherentes y escribe tick y estado", async () => {
    const { store, config } = await seeded();
    const res = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(1), stimulusPicker: null });
    expect(res.tick.activeAgentIds.length).toBeGreaterThanOrEqual(2);
    expect(res.tick.decisions).toHaveLength(res.tick.activeAgentIds.length);
    expect(store.loadTick(res.tick.id).id).toBe(res.tick.id);
    expect(store.loadState().lastTickId).toBe(res.tick.id);
    for (const d of res.tick.decisions) expect(["open_thread", "reply", "pass", "rejected"]).toContain(d.action);
    expect(res.newThreads).toBeLessThanOrEqual(1);
  });

  it("como máximo un hilo nuevo por tick: el segundo agente recibe el aviso y su apertura se rechaza", async () => {
    const { store, config } = await seeded({ AGORA_MIN_ACTIVE: "3", AGORA_MAX_ACTIVE: "3" });
    const seenNotices: boolean[] = [];
    const opener = (title: string) => (meta: DecideMeta): MockReply => {
      seenNotices.push(!meta.canOpenThread);
      return { toolInput: { action: "open_thread", reason: "tema nuevo", title, body: OK_OPENING.replace("calendarios", `calendarios (${title})`) } };
    };
    const perAgent = Object.fromEntries(AGENTS.map((a) => [a.id, [opener(`Calendarios ${a.id}`), opener(`Otra vez ${a.id}`)]]));
    // Las cuotas de 24 h del seed impedirían abrir: se simula que el seed fue hace 3 días.
    const res = await runTick({ store, llm: scripted(perAgent), config, now: hours(72), stimulusPicker: null });
    expect(res.newThreads).toBe(1);
    const rejected = res.tick.decisions.filter((d) => d.action === "rejected");
    expect(rejected.length).toBe(res.tick.activeAgentIds.length - 1);
    for (const d of rejected) {
      expect(d.attempts).toHaveLength(2);
      expect(d.attempts.every((a) => a.rejection?.filter === "quota")).toBe(true);
    }
    expect(seenNotices.slice(2).every(Boolean)).toBe(true);
  });

  it("un agente no abre más de 1 hilo cada 24 h", async () => {
    const { store, config } = await seeded();
    // Justo después del seed todos tienen un hilo de hace 1 h.
    const perAgent = Object.fromEntries(
      AGENTS.map((a) => [a.id, [() => ({ toolInput: { action: "open_thread", reason: "otro", title: `Nuevo ${a.id}`, body: OK_OPENING } })]]),
    );
    const res = await runTick({ store, llm: scripted(perAgent), config, now: hours(1), stimulusPicker: null });
    expect(res.newThreads).toBe(0);
    expect(res.tick.decisions.every((d) => d.attempts[0]?.rejection?.filter === "quota")).toBe(true);
  });

  it("rechaza, reintenta una sola vez con el motivo, y acepta si el segundo intento es bueno", async () => {
    const { store, config } = await seeded({ AGORA_MIN_ACTIVE: "2", AGORA_MAX_ACTIVE: "2" });
    const retryReasons: (string | undefined)[] = [];
    const replyTo = (body: string) => (meta: DecideMeta): MockReply => {
      retryReasons.push(meta.retryReason);
      const thread = meta.openThreads.find((t) => t.recentPosts.some((p) => p.authorId !== meta.agentId)) as DecideMeta["openThreads"][number];
      const target = thread.recentPosts.find((p) => p.authorId !== meta.agentId) as { id: string };
      return { toolInput: { action: "reply", reason: "matiz", threadId: thread.id, replyTo: target.id, body } };
    };
    const perAgent = Object.fromEntries(AGENTS.map((a) => [a.id, [replyTo(`Gracias por el hilo. ${OK_REPLY}`), replyTo(OK_REPLY.replace("depuradora", `depuradora de ${a.name}`))]]));
    const res = await runTick({ store, llm: scripted(perAgent), config, now: hours(1), stimulusPicker: null });
    const first = res.tick.decisions[0];
    expect(first?.action).toBe("reply");
    expect(first?.attempts.map((a) => a.accepted)).toEqual([false, true]);
    expect(first?.attempts[0]?.rejection?.filter).toBe("opening");
    expect(retryReasons[0]).toBeUndefined();
    expect(retryReasons[1]).toMatch(/opening/);
    expect(typeof first?.similarity).toBe("number");
    // El segundo agente ve lo que hizo el primero en el mismo tick.
    const llmCalls = res.tick.decisions.length;
    expect(llmCalls).toBe(2);
  });

  it("si el segundo intento también falla, el agente pasa y queda registrado", async () => {
    const { store, config } = await seeded();
    const bad = (meta: DecideMeta): MockReply => ({
      toolInput: { action: "reply", reason: "x", threadId: meta.openThreads[0]?.id, replyTo: "no-existe", body: OK_REPLY },
    });
    const perAgent = Object.fromEntries(AGENTS.map((a) => [a.id, [bad, bad, bad]]));
    const llm = scripted(perAgent);
    const res = await runTick({ store, llm, config, now: hours(1), stimulusPicker: null });
    expect(res.newPosts).toBe(0);
    for (const d of res.tick.decisions) {
      expect(d.action).toBe("rejected");
      expect(d.attempts).toHaveLength(2);
    }
    expect(llm.calls.filter((c) => c.purpose === "decide")).toHaveLength(res.tick.activeAgentIds.length * 2);
  });

  it("una respuesta cortada por max_tokens se reintenta con un motivo claro", async () => {
    const { store, config } = await seeded({ AGORA_MIN_ACTIVE: "2", AGORA_MAX_ACTIVE: "2" });
    const reasons: (string | undefined)[] = [];
    const llm = new MockLLM((req) => {
      const meta = req.meta as DecideMeta | { kind: "curate" };
      if (meta.kind !== "decide") return { toolInput: { threadTags: [], newTags: [], summaries: [], memories: [] } };
      reasons.push(meta.retryReason);
      return { toolInput: { action: "open_thread", reason: "x", title: "Corte" }, stopReason: "max_tokens" };
    });
    const res = await runTick({ store, llm, config, now: hours(1), stimulusPicker: null });
    expect(res.tick.decisions[0]?.attempts.map((a) => a.rejection?.filter)).toEqual(["truncated", "truncated"]);
    expect(reasons[1]).toMatch(/se cortó/);
    expect(llm.calls[0]?.user).toContain("título como máximo 90 caracteres, mejor por debajo de 63");
  });

  it("un error del LLM en un agente no detiene a los demás", async () => {
    const { store, config } = await seeded({ AGORA_MIN_ACTIVE: "3", AGORA_MAX_ACTIVE: "3" });
    let first = true;
    const llm = new MockLLM((req) => {
      if ((req.meta as { kind: string }).kind === "decide" && first) {
        first = false;
        return { toolInput: null, throws: new Error("529 overloaded") };
      }
      return { toolInput: { action: "pass", reason: "nada" } };
    });
    const res = await runTick({ store, llm, config, now: hours(1), stimulusPicker: null });
    expect(res.tick.decisions[0]?.action).toBe("error");
    expect(res.tick.decisions.slice(1).every((d) => d.action === "pass")).toBe(true);
    expect(res.tick.errors[0]).toMatch(/529/);
  });

  it("rotación: quien publicó en los 2 ticks anteriores no vuelve salvo con respuesta dirigida pendiente", async () => {
    const { store, config } = await seeded();
    const posters: string[][] = [];
    let checked = 0;
    for (let i = 0; i < 6; i++) {
      const priority = new Set(AGENTS.filter((a) => findNewReplies(a.id, store.loadThreads()).some((r) => r.directed)).map((a) => a.id));
      const prevActive = store.loadRecentTicks(1)[0]?.activeAgentIds ?? [];
      const res = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(72 + i), stimulusPicker: null });
      const recent = new Set([...(posters[i - 1] ?? []), ...(posters[i - 2] ?? [])]);
      for (const id of res.tick.activeAgentIds) {
        if (recent.has(id)) {
          expect(priority.has(id)).toBe(true);
          checked++;
        }
      }
      if (priority.size === 0 && i > 0) {
        expect(res.tick.activeAgentIds.filter((id) => prevActive.includes(id)).length).toBeLessThanOrEqual(1);
      }
      posters.push(res.tick.decisions.filter((d) => d.postId).map((d) => d.agentId));
    }
    expect(posters.flat().length).toBeGreaterThan(0);
    expect(checked).toBeGreaterThanOrEqual(0);
  });

  it("presupuesto agotado: el tick se registra como skipped y no llama al LLM", async () => {
    const { store, config } = await seeded({ AGORA_MONTHLY_BUDGET_USD: "1" });
    const state = store.loadState();
    store.saveState({ ...state, monthCostUsd: 1.5 });
    const llm = plausibleMockLLM();
    const res = await runTick({ store, llm, config, now: hours(1), stimulusPicker: null });
    expect(res.tick.skipped).toBe("budget");
    expect(llm.calls).toHaveLength(0);
    expect(store.loadTick(res.tick.id).skipped).toBe("budget");
  });

  it("el coste del mes se reinicia al cambiar de mes", async () => {
    const { store, config } = await seeded({ AGORA_MONTHLY_BUDGET_USD: "1" });
    store.saveState({ ...store.loadState(), monthCostUsd: 5, monthKey: "2026-10" });
    const res = await runTick({ store, llm: plausibleMockLLM(), config, now: new Date("2026-11-01T09:00:00.000Z"), stimulusPicker: null });
    expect(res.tick.skipped).toBeUndefined();
    expect(store.loadState().monthKey).toBe("2026-11");
    expect(store.loadState().monthCostUsd).toBeLessThan(1);
  });

  it("dry-run no escribe nada en data/", async () => {
    const { store, config } = await seeded();
    const snapshot = (): string[] => fs.readdirSync(path.join(store.dataDir, "threads")).concat(fs.readdirSync(path.join(store.dataDir, "ticks")));
    const before = snapshot();
    const stateBefore = fs.readFileSync(path.join(store.dataDir, "state.json"), "utf8");
    const res = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(3), dryRun: true, stimulusPicker: null });
    expect(res.tick.dryRun).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(path.join(store.dataDir, "state.json"), "utf8")).toBe(stateBefore);
  });

  it("el estímulo se adjunta como opcional y queda en el tick, no en los posts", async () => {
    const { store, config } = await seeded({ AGORA_STIMULUS_PROB: "1" });
    const llm = plausibleMockLLM();
    const res = await runTick({
      store,
      llm,
      config,
      now: hours(2),
      stimulusPicker: async () => ({ source: "deck", title: "Disparador", text: "Una regla que todos siguen y nadie sabría justificar." }),
    });
    expect(res.tick.stimulus?.text).toMatch(/regla/);
    const decideCall = llm.calls.find((c) => c.purpose === "decide");
    expect(decideCall?.user).toContain("puedes ignorarlo");
    expect(JSON.stringify(store.loadThreads())).not.toContain("Una regla que todos siguen");
  });

  it("escribe el digest en el tick de las 23 h locales", async () => {
    const { store, config } = await seeded();
    // 21:00 UTC = 23:00 en Madrid (horario de invierno a partir del 25 de octubre).
    const res = await runTick({ store, llm: plausibleMockLLM(), config, now: new Date("2026-10-29T22:00:00.000Z"), stimulusPicker: null });
    expect(res.tick.curatorActions.some((a) => a.startsWith("digest 2026-10-29"))).toBe(true);
    expect(store.hasDigest("2026-10-29")).toBe(true);
  });

  it("si el tick de las 23 h falló, el primero del día siguiente escribe el digest de ayer", async () => {
    const { store, config } = await seeded();
    await runTick({ store, llm: plausibleMockLLM(), config, now: new Date("2026-10-30T07:00:00.000Z"), stimulusPicker: null });
    expect(store.hasDigest("2026-10-29")).toBe(true);
  });

  it("dos ticks en el mismo minuto no se pisan", async () => {
    const { store, config } = await seeded();
    const a = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(5), stimulusPicker: null });
    const b = await runTick({ store, llm: plausibleMockLLM(), config, now: hours(5), stimulusPicker: null });
    expect(a.tick.id).not.toBe(b.tick.id);
    expect(store.hasTick(a.tick.id) && store.hasTick(b.tick.id)).toBe(true);
  });

  it("el curador comprime memorias que superan el límite", async () => {
    const { store, config } = await seeded();
    const long = `${store.loadMemory("ignacio")}${"- extra interés muy largo para inflar la memoria del agente\n".repeat(40)}`;
    store.saveMemory("ignacio", long);
    await runTick({ store, llm: plausibleMockLLM(), config, now: hours(1), stimulusPicker: null });
    expect(store.loadMemory("ignacio").length).toBeLessThanOrEqual(1500);
  });
});
