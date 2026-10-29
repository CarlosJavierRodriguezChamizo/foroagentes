import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentSchema,
  BannedPhrasesSchema,
  DecideInputSchema,
  QualityConfigSchema,
  StimuliDeckSchema,
  TagsFileSchema,
  ThreadSchema,
  TickSchema,
} from "../engine/forum/schema";
import { slugify, tickIdFromDate, dateFromTickId, localParts, createRng } from "../engine/forum/util";
import { ForumStore, writeJsonAtomic } from "../engine/forum/store";
import { makeTempDataDir } from "./helpers";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const readData = (f: string): unknown => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

const validThread = {
  id: "2026-10-29-el-mapa-no-es-el-territorio",
  title: "El mapa no es el territorio",
  authorId: "amparo",
  tags: ["epistemologia"],
  status: "open",
  createdAt: "2026-10-29T10:00:00.000Z",
  lastActivityAt: "2026-10-29T10:00:00.000Z",
  summary: "",
  posts: [
    {
      id: "p-2026-10-29T1000Z-amparo",
      authorId: "amparo",
      createdAt: "2026-10-29T10:00:00.000Z",
      body: "Texto",
      tickId: "2026-10-29T1000Z",
      kind: "opening",
    },
  ],
};

describe("esquemas", () => {
  it("los ficheros de configuración del repo son válidos", () => {
    expect(() => QualityConfigSchema.parse(readData("quality.json"))).not.toThrow();
    expect(() => BannedPhrasesSchema.parse(readData("banned-phrases.json"))).not.toThrow();
    expect(TagsFileSchema.parse(readData("tags.json")).tags.length).toBeGreaterThanOrEqual(25);
    expect(StimuliDeckSchema.parse(readData("stimuli.json")).prompts).toHaveLength(40);
  });

  it("todas las regex de frases prohibidas compilan", () => {
    const banned = BannedPhrasesSchema.parse(readData("banned-phrases.json"));
    for (const p of banned.patterns) expect(() => new RegExp(p.pattern, "i")).not.toThrow();
    for (const o of banned.openers) expect(() => new RegExp(`^${o}`, "i")).not.toThrow();
    expect(banned.patterns.filter((p) => p.lang === "es").length).toBeGreaterThanOrEqual(40);
  });

  it("acepta un hilo válido y rellena summaryPostCount", () => {
    const t = ThreadSchema.parse(validThread);
    expect(t.summaryPostCount).toBe(0);
  });

  it("rechaza hilos sin posts o con estado desconocido", () => {
    expect(ThreadSchema.safeParse({ ...validThread, posts: [] }).success).toBe(false);
    expect(ThreadSchema.safeParse({ ...validThread, status: "closed" }).success).toBe(false);
  });

  it("valida agentes: rangos de temperatura y peso", () => {
    const agent = {
      id: "x",
      name: "Xavi",
      avatar: "X",
      bio: "Una bio suficientemente larga para pasar.",
      interests: ["a1", "b1", "c1", "d1"],
      epistemicStyle: "Razona con cuidado, pide definiciones y desconfía de los atajos fáciles.",
      voice: "Escribe corto, sin adornos y sin chistes; usa ejemplos concretos cuando puede.",
      blindSpots: ["ignora la historia", "subestima lo social"],
      temperature: 0.7,
      activityWeight: 1,
      createdAt: "2026-10-29T00:00:00.000Z",
    };
    expect(AgentSchema.safeParse(agent).success).toBe(true);
    expect(AgentSchema.safeParse({ ...agent, temperature: 1.4 }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...agent, activityWeight: 0.1 }).success).toBe(false);
  });

  it("valida la entrada de decide", () => {
    expect(DecideInputSchema.safeParse({ action: "pass", reason: "nada que añadir" }).success).toBe(true);
    expect(DecideInputSchema.safeParse({ action: "shout", reason: "x" }).success).toBe(false);
  });

  it("valida ids de tick", () => {
    const base = {
      id: "2026-10-29T1300Z",
      startedAt: "2026-10-29T13:00:00.000Z",
      finishedAt: "2026-10-29T13:00:05.000Z",
      dryRun: false,
      activeAgentIds: [],
      decisions: [],
      curatorActions: [],
      totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      errors: [],
    };
    expect(TickSchema.safeParse(base).success).toBe(true);
    expect(TickSchema.safeParse({ ...base, id: "2026-10-29T13:00Z" }).success).toBe(false);
  });
});

describe("utilidades", () => {
  it("slugify quita acentos y limita longitud", () => {
    expect(slugify("¿El mapa NO es el territorio?")).toBe("el-mapa-no-es-el-territorio");
    expect(slugify("Ñandúes y cigüeñas")).toBe("nandues-y-ciguenas");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });

  it("tickId ida y vuelta", () => {
    const d = new Date("2026-10-29T13:07:42.000Z");
    expect(tickIdFromDate(d)).toBe("2026-10-29T1307Z");
    expect(dateFromTickId("2026-10-29T1307Z").toISOString()).toBe("2026-10-29T13:07:00.000Z");
  });

  it("localParts respeta la zona horaria", () => {
    const p = localParts(new Date("2026-10-29T22:30:00.000Z"), "Europe/Madrid");
    expect(p).toEqual({ date: "2026-10-29", hour: 23, minute: 30 });
  });

  it("el RNG es reproducible", () => {
    const a = createRng("semilla");
    const b = createRng("semilla");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("store", () => {
  it("escribe JSON de forma atómica sin dejar temporales", () => {
    const dir = makeTempDataDir();
    const file = path.join(dir, "threads", "x.json");
    writeJsonAtomic(file, { a: 1 });
    writeJsonAtomic(file, { a: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 2 });
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("guarda y lee hilos validados", () => {
    const store = new ForumStore(makeTempDataDir());
    store.saveThread(ThreadSchema.parse(validThread));
    expect(store.loadThreads()[0]?.id).toBe(validThread.id);
    expect(store.loadState().monthCostUsd).toBe(0);
  });

  it("rechaza JSON corrupto con un error claro", () => {
    const dir = makeTempDataDir();
    fs.writeFileSync(path.join(dir, "threads", "bad.json"), "{ nope");
    expect(() => new ForumStore(dir).loadThreads()).toThrow(/JSON inválido/);
  });
});
