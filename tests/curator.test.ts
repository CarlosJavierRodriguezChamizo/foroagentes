import { describe, expect, it } from "vitest";
import { runCurator, curatorJobIsEmpty, type CuratorJob, type CuratorOptions } from "../engine/curator/curator";
import { MockLLM } from "../engine/llm/mock";
import { initialMemory } from "../engine/agents/memory";
import { AGENT_MAP, makePost, makeThread } from "./fixtures";

const vocabulary = [
  { slug: "economia", label: "economía" },
  { slug: "historia", label: "historia" },
  { slug: "trabajo", label: "trabajo" },
];

const thread = makeThread("2026-10-29-mantenimiento", "El mantenimiento invisible", [
  makePost("carmen", "El mantenimiento es la mayor parte del coste. Nadie lo presupuesta.", { kind: "opening" }),
]);
const longThread = makeThread(
  "2026-10-29-largo",
  "Hilo largo",
  Array.from({ length: 6 }, (_, i) => makePost(i % 2 ? "oscar" : "paula", `Argumento ${i}.`)),
  { summary: "viejo", summaryPostCount: 1 },
);
let bigMemory = initialMemory(["Creo que A."], ["x"], "2026-10-29");
bigMemory += "- interés de relleno bastante largo para superar el límite\n".repeat(40);

function opts(llm: MockLLM, job: Partial<CuratorJob> = {}): CuratorOptions {
  return {
    llm,
    model: "claude-haiku-5-5",
    lang: "es",
    job: { newThreads: [thread], summaryThreads: [longThread], memories: [{ agentId: "carmen", memory: bigMemory }], ...job },
    vocabulary,
    agents: AGENT_MAP,
    suggestions: new Map([[thread.id, ["Trabajo"]]]),
    memoryMaxChars: 1500,
    citations: new Map(),
  };
}

describe("curador", () => {
  it("no llama al LLM si no hay trabajo", async () => {
    const llm = MockLLM.queue([{ toolInput: {} }]);
    const job = { newThreads: [], summaryThreads: [], memories: [] };
    expect(curatorJobIsEmpty(job)).toBe(true);
    await runCurator(opts(llm, job));
    expect(llm.calls).toHaveLength(0);
  });

  it("aplica etiquetas del vocabulario, nuevas etiquetas, resúmenes, memorias y digest", async () => {
    const goodMemory = initialMemory(["Creo que A, comprimido."], ["x"], "2026-10-29");
    const llm = MockLLM.queue([
      {
        toolInput: {
          threadTags: [{ threadId: thread.id, tags: ["economia", "inexistente", "Infraestructuras"] }],
          newTags: [{ slug: "Infraestructuras", label: "Infraestructuras" }],
          summaries: [
            { threadId: thread.id, summary: "Carmen sostiene que el mantenimiento domina el coste." },
            { threadId: longThread.id, summary: "x".repeat(600) },
          ],
          memories: [{ agentId: "carmen", memory: goodMemory }],
          digest: "Hoy se habló de mantenimiento. Óscar discrepó de Paula.",
        },
      },
    ]);
    const out = await runCurator(opts(llm, { digest: { date: "2026-10-29", posts: [] } }));
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.model).toBe("claude-haiku-5-5");
    expect(out.newTags).toEqual([{ slug: "infraestructuras", label: "infraestructuras" }]);
    expect(out.threadTags.get(thread.id)).toEqual(["economia", "infraestructuras"]);
    expect(out.summaries.get(thread.id)).toMatch(/Carmen/);
    expect(out.summaries.get(longThread.id)?.length).toBeLessThanOrEqual(400);
    expect(out.memories.get("carmen")?.trim()).toBe(goodMemory.trim());
    expect(out.digest).toMatch(/Óscar/);
    expect(out.costUsd).toBeGreaterThan(0);
  });

  it("usa respaldos deterministas si el LLM falla", async () => {
    const llm = MockLLM.queue([{ toolInput: null, throws: new Error("sin red") }]);
    const out = await runCurator(opts(llm, { digest: { date: "2026-10-29", posts: [] } }));
    expect(out.error).toMatch(/sin red/);
    expect(out.threadTags.get(thread.id)).toEqual(["trabajo"]);
    expect(out.summaries.get(thread.id)).toMatch(/mantenimiento/);
    expect(out.memories.get("carmen")?.length).toBeLessThanOrEqual(1500);
    expect(out.digest).toBeUndefined();
  });

  it("rechaza una memoria comprimida que rompe el formato o el límite", async () => {
    const llm = MockLLM.queue([{ toolInput: { threadTags: [], newTags: [], summaries: [], memories: [{ agentId: "carmen", memory: "texto libre sin secciones" }] } }]);
    const out = await runCurator(opts(llm));
    expect(out.memories.get("carmen")).toContain("## Posiciones que mantengo");
    expect(out.actions.some((a) => a.includes("[respaldo]"))).toBe(true);
  });
});
