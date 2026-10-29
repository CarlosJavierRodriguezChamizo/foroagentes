import { describe, expect, it } from "vitest";
import { INITIAL_AGENTS } from "../engine/agents/initial";
import { buildSystemPrompt } from "../engine/agents/prompt";
import { HOUSE_RULES_ES } from "../engine/agents/houseRules";
import { buildContext, findNewReplies } from "../engine/agents/context";
import { applyMemoryUpdate, compressMemoryLocally, initialMemory, parseMemory } from "../engine/agents/memory";
import { AgentSchema } from "../engine/forum/schema";
import { estimateTokens } from "../engine/forum/util";
import { AGENTS, AGENT_MAP, filler, makePost, makeThread } from "./fixtures";

describe("agentes iniciales", () => {
  it("hay exactamente 8, válidos, con ids y estilos distintos", () => {
    expect(INITIAL_AGENTS).toHaveLength(8);
    for (const a of AGENTS) expect(() => AgentSchema.parse(a)).not.toThrow();
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(8);
    expect(new Set(AGENTS.map((a) => a.epistemicStyle)).size).toBe(8);
    expect(new Set(AGENTS.map((a) => a.voice)).size).toBe(8);
  });

  it("los intereses se solapan parcialmente y cada uno tiene alguno exclusivo", () => {
    const counts = new Map<string, number>();
    for (const a of AGENTS) for (const i of a.interests) counts.set(i, (counts.get(i) ?? 0) + 1);
    const shared = [...counts.values()].filter((c) => c >= 3).length;
    expect(shared).toBeGreaterThanOrEqual(2);
    for (const a of AGENTS) expect(a.interests.some((i) => counts.get(i) === 1)).toBe(true);
  });

  it("cada memoria inicial tiene 2-3 posiciones", () => {
    for (const a of INITIAL_AGENTS) {
      expect(a.positions.length).toBeGreaterThanOrEqual(2);
      expect(a.positions.length).toBeLessThanOrEqual(3);
      expect(initialMemory(a.positions, a.currentInterests, "2026-10-29").length).toBeLessThan(1500);
    }
  });
});

describe("memoria", () => {
  const base = initialMemory(["Creo que A."], ["tema uno", "tema dos"], "2026-10-29");

  it("parsea y serializa ida y vuelta", () => {
    const m = parseMemory(base);
    expect(m.positions[0]).toEqual({ date: "2026-10-29", threadId: "inicial", text: "Creo que A." });
    expect(m.interests).toEqual(["tema uno", "tema dos"]);
  });

  it("añade posiciones con fecha e hilo y retira intereses con 'ya no:'", () => {
    const updated = applyMemoryUpdate(base, { positions: ["Creo que B."], interests: ["tema tres", "ya no: tema uno"] }, "2026-10-30", "2026-10-30-hilo");
    const m = parseMemory(updated);
    expect(m.positions.map((p) => p.text)).toEqual(["Creo que A.", "Creo que B."]);
    expect(m.positions[1]?.threadId).toBe("2026-10-30-hilo");
    expect(m.interests).toEqual(["tema dos", "tema tres"]);
  });

  it("una posición casi idéntica sustituye a la anterior", () => {
    const updated = applyMemoryUpdate(base, { positions: ["creo que a"] }, "2026-10-31", "h");
    expect(parseMemory(updated).positions).toHaveLength(1);
  });

  it("la compresión local respeta el límite y conserva lo citado", () => {
    let mem = base;
    for (let i = 0; i < 30; i++) mem = applyMemoryUpdate(mem, { positions: [`Posición número ${i} con bastante texto para ocupar sitio en la memoria.`] }, "2026-10-30", `h-${i}`);
    expect(mem.length).toBeGreaterThan(1500);
    const compressed = compressMemoryLocally(mem, 1500, new Map([["h-3", 5]]));
    expect(compressed.length).toBeLessThanOrEqual(1500);
    expect(compressed).toContain("h-3");
    expect(compressed).toContain("h-29");
  });
});

describe("system prompt", () => {
  const agent = AGENTS[0]!;
  it("incluye reglas literales y memoria, nunca los blindSpots", () => {
    const sys = buildSystemPrompt(agent, "## Posiciones que mantengo\n- (2026-10-29, inicial) X", "es");
    expect(sys).toContain(HOUSE_RULES_ES);
    expect(sys).toContain("(2026-10-29, inicial) X");
    expect(sys).toContain(agent.epistemicStyle);
    for (const b of agent.blindSpots) expect(sys).not.toContain(b);
    expect(sys).toContain("decide");
  });
});

describe("contexto", () => {
  const agent = AGENT_MAP.get("ignacio")!;
  const now = new Date("2026-10-29T12:00:00.000Z");
  const baseInput = {
    now,
    tz: "Europe/Madrid",
    lang: "es" as const,
    agent,
    agents: AGENT_MAP,
    mode: "normal" as const,
    tickActions: [],
    threadOpenedThisTick: false,
    tokenBudget: 6000,
  };

  function bigForum(): ReturnType<typeof makeThread>[] {
    const threads = [];
    for (let i = 0; i < 14; i++) {
      const posts = [makePost("amparo", filler(`a${i}`, 300), { kind: "opening", createdAt: new Date(Date.UTC(2026, 9, 29, 0, i)).toISOString() })];
      for (let j = 0; j < 4; j++) posts.push(makePost(j % 2 ? "oscar" : "carmen", filler(`b${i}${j}`, 300), { createdAt: new Date(Date.UTC(2026, 9, 29, 1 + j, i)).toISOString() }));
      threads.push(makeThread(`2026-10-29-hilo-${i}`, `Hilo número ${i}`, posts, { summary: filler(`s${i}`, 50).slice(0, 390) }));
    }
    return threads;
  }

  it("muestra como máximo 12 hilos abiertos", () => {
    const ctx = buildContext({ ...baseInput, threads: bigForum(), tokenBudget: 1_000_000 });
    expect(ctx.meta.openThreads).toHaveLength(12);
    expect(ctx.text.match(/^### «/gm)).toHaveLength(12);
  });

  it("respeta el presupuesto recortando primero los posts íntegros", () => {
    const ctx = buildContext({ ...baseInput, threads: bigForum() });
    expect(ctx.estimatedTokens).toBeLessThanOrEqual(6000);
    expect(ctx.trimmed.fullPostThreadsDropped).toBeGreaterThan(0);
    // Los títulos de los hilos nunca desaparecen.
    expect(ctx.text).toContain("Hilo número 13");
  });

  it("con un presupuesto mínimo recorta también resúmenes, sin tocar el system prompt", () => {
    const sysBefore = buildSystemPrompt(agent, "mem", "es");
    const ctx = buildContext({ ...baseInput, threads: bigForum(), tokenBudget: 600 });
    expect(ctx.trimmed.summariesDropped).toBeGreaterThan(0);
    expect(buildSystemPrompt(agent, "mem", "es")).toBe(sysBefore);
    expect(estimateTokens(ctx.text)).toBeLessThan(estimateTokens(buildContext({ ...baseInput, threads: bigForum(), tokenBudget: 1e6 }).text));
  });

  it("señala respuestas dirigidas al agente y avisos de cuota, estímulo y saturación", () => {
    const own = makePost("ignacio", "Mi post original con un dato.", { kind: "opening" });
    const answer = makePost("oscar", "Respuesta a Ignacio con un contraejemplo.", { replyTo: own.id });
    const thread = makeThread("2026-10-29-sobre-datos", "Sobre datos", [own, answer]);
    const ctx = buildContext({
      ...baseInput,
      threads: [thread],
      threadOpenedThisTick: true,
      stimulus: { source: "deck", title: "Disparador", text: "Algo que medimos porque se puede medir." },
      saturatedTag: "economía",
      retryReason: "similitud 0.41",
    });
    expect(ctx.text).toContain("DIRIGIDA A TI");
    expect(ctx.text).toContain("Ya se ha abierto un hilo en este tick");
    expect(ctx.text).toContain("puedes ignorarlo");
    expect(ctx.text).toContain("saturado de economía");
    expect(ctx.text).toContain("similitud 0.41");
    expect(ctx.meta.directedReplies.map((r) => r.id)).toEqual([answer.id]);
    expect(ctx.meta.canOpenThread).toBe(false);
  });

  it("findNewReplies ignora hilos donde el agente no ha escrito y posts anteriores al suyo", () => {
    const a = makePost("carmen", "antes", { kind: "opening" });
    const b = makePost("ignacio", "mío");
    const c = makePost("carmen", "después", { replyTo: b.id });
    const other = makeThread("2026-10-29-otro", "Otro", [makePost("paula", "x", { kind: "opening" })]);
    const res = findNewReplies("ignacio", [makeThread("2026-10-29-t", "T", [a, b, c]), other]);
    expect(res.map((r) => r.post.body)).toEqual(["después"]);
    expect(res[0]?.directed).toBe(true);
  });
});
