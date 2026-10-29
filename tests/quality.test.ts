import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BannedPhrasesSchema, QualityConfigSchema, type DecideInput } from "../engine/forum/schema";
import {
  badOpening,
  checkQuality,
  compileBanned,
  countListItems,
  findBannedPhrase,
  jaccard,
  maxBodySimilarity,
  maxTitleSimilarity,
  normalizeWords,
  wordNgrams,
  type QualityInput,
} from "../engine/tick/quality";
import { makePost, makeThread } from "./fixtures";

const DATA = path.resolve(import.meta.dirname, "..", "data");
const config = QualityConfigSchema.parse(JSON.parse(fs.readFileSync(path.join(DATA, "quality.json"), "utf8")));
const banned = compileBanned(BannedPhrasesSchema.parse(JSON.parse(fs.readFileSync(path.join(DATA, "banned-phrases.json"), "utf8"))));

const REPLY_BODY =
  "Dices que los indicadores dejan de medir en cuanto se usan para pagar. No lo veo tan general. " +
  "En la depuradora medimos la turbidez del agua de salida y nos pagan por ella desde hace veinte años, y sigue midiendo lo mismo porque el sensor no lo controla quien cobra.\n\n" +
  "La distinción que falta es quién puede tocar el instrumento. Si el que cobra también calibra, tienes razón. Si no, el indicador aguanta bastante bien.";

const OPENING_BODY =
  "Propongo una tesis concreta: la mayor parte del coste real de una infraestructura pública no está en construirla sino en mantenerla durante cuarenta años, y casi ningún presupuesto lo refleja. " +
  "Lo he visto en bombas, en colectores y en estaciones enteras que se inauguraron con fotos y se fueron degradando sin repuestos.\n\n" +
  "Si la tesis es cierta, la pregunta interesante no es cuánto cuesta una obra sino quién se compromete a pagar su vejez. " +
  "Y si es falsa, me gustaría ver un caso en que el mantenimiento se presupuestó bien desde el principio y qué lo hizo posible, porque yo no lo he encontrado en quince años de turnos.";

const longParagraphs = (n: number): string => Array.from({ length: n }, (_, i) => `Frase distinta número ${i} sobre materiales, turnos y calibraciones.`).join(" ");

function input(decision: DecideInput, overrides: Partial<QualityInput> = {}): QualityInput {
  const opening = makePost("ignacio", "Un indicador que se usa para pagar a alguien deja de medir lo que medía en dos años. Lo he visto en urgencias con los tiempos de espera.", {
    id: "p-1-ignacio",
    kind: "opening",
  });
  const thread = makeThread("2026-10-29-indicadores", "Indicadores que dejan de medir", [opening]);
  return {
    decision,
    agentId: "carmen",
    thread: decision.action === "reply" ? thread : undefined,
    agentRecentPosts: [],
    recentTitles: ["Indicadores que dejan de medir"],
    otherAgentNames: ["Ignacio Salvatierra", "Óscar Peñalba", "Paula Arrieta"],
    config,
    banned,
    ...overrides,
  };
}

const reply = (body: string, extra: Partial<DecideInput> = {}): DecideInput => ({
  action: "reply",
  reason: "r",
  threadId: "2026-10-29-indicadores",
  replyTo: "p-1-ignacio",
  body,
  ...extra,
});
const open = (title: string, body: string): DecideInput => ({ action: "open_thread", reason: "r", title, body });

describe("normalización y similitud", () => {
  it("normaliza acentos, mayúsculas y quita stopwords", () => {
    expect(normalizeWords("El Camión de la Ñora, ¡ya!")).toEqual(["camion", "nora"]);
  });

  it("jaccard de conjuntos idénticos es 1 y de disjuntos 0", () => {
    const a = wordNgrams("uno dos tres cuatro cinco", 3);
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, wordNgrams("seis siete ocho nueve", 3))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it("textos muy cortos producen un único n-grama", () => {
    expect(wordNgrams("hola mundo", 3).size).toBe(1);
    expect(wordNgrams("", 3).size).toBe(0);
  });

  it("detecta paráfrasis literal pese a mayúsculas y puntuación", () => {
    expect(maxBodySimilarity(REPLY_BODY, [REPLY_BODY.toUpperCase().replace(/\./g, "!")])).toBe(1);
  });

  it("el umbral de 0.35 se aplica en el límite", () => {
    // 13 palabras de contenido → 11 trigramas; compartiendo los 7 primeros la similitud es 7/15 ≈ 0.467.
    const a = "alfa beta gama delta epsilon zeta eta theta iota kappa lambda mu nu";
    const b = "alfa beta gama delta epsilon zeta eta theta iota rojo verde azul negro";
    const sim = maxBodySimilarity(a, [b]);
    expect(sim).toBeGreaterThan(0.35);
    const c = "alfa beta gama delta rojo verde azul negro blanco gris marron ocre lila";
    expect(maxBodySimilarity(a, [c])).toBeLessThan(0.35);
  });

  it("similitud de títulos por bigramas", () => {
    expect(maxTitleSimilarity("Indicadores que dejan de medir", ["Los indicadores que dejan de medir"])).toBe(1);
    expect(maxTitleSimilarity("El mantenimiento invisible", ["Indicadores que dejan de medir"])).toBe(0);
  });
});

describe("frases prohibidas y arranques", () => {
  it.each([
    "En el vertiginoso mundo de la tecnología pasan cosas.",
    "Es importante destacar que esto no es así.",
    "En conclusión, no.",
    "Por un lado tenemos esto y por otro lado lo otro.",
    "Gran reflexión la tuya.",
    "Juega un papel crucial.",
    "¿Qué opináis vosotros?",
    "Totalmente de acuerdo con lo anterior.",
  ])("ES: %s", (text) => {
    expect(findBannedPhrase(text, banned)).not.toBeNull();
  });

  it.each([
    "In the fast-paced world of software, things move.",
    "It is important to note that this fails.",
    "In conclusion, no.",
    "On the one hand this, on the other hand that.",
    "Great point about sensors.",
    "Let us delve into this.",
    "This plays a crucial role.",
  ])("EN: %s", (text) => {
    expect(findBannedPhrase(text, banned)).not.toBeNull();
  });

  it("no da falsos positivos en texto normal", () => {
    expect(findBannedPhrase(REPLY_BODY, banned)).toBeNull();
    expect(findBannedPhrase("Lo importante es destacar el sensor, no el contrato.", banned)).toBeNull();
    expect(findBannedPhrase("Por un lado del río estaba la fábrica.", banned)).toBeNull();
  });

  it("rechaza arranques con nombre del interlocutor y cortesías", () => {
    const names = ["Ignacio Salvatierra", "Óscar Peñalba"];
    expect(badOpening("Ignacio, no estoy de acuerdo.", banned, names)).toBe("Ignacio,");
    expect(badOpening("óscar , mira.", banned, names)).toBe("Óscar,");
    expect(badOpening("Ignacio Salvatierra, mira.", banned, names)).not.toBeNull();
    expect(badOpening("Gracias por el dato.", banned, names)).not.toBeNull();
    expect(badOpening("«Interesante» no es un argumento.", banned, names)).not.toBeNull();
    expect(badOpening("Buen punto, pero...", banned, names)).not.toBeNull();
    expect(badOpening("Thanks for this.", banned, names)).not.toBeNull();
    expect(badOpening("Ignacio dice que el sensor falla.", banned, names)).toBeNull();
    expect(badOpening("Interesar a alguien es difícil.", banned, names)).toBeNull();
  });
});

describe("listas", () => {
  it("cuenta viñetas y listas numeradas", () => {
    expect(countListItems("- uno\n- dos\n* tres")).toBe(3);
    expect(countListItems("1. uno\n2) dos")).toBe(2);
    expect(countListItems("Texto normal - con guion en medio.\n\nOtro párrafo.")).toBe(0);
  });
});

describe("checkQuality", () => {
  it("acepta una buena respuesta y devuelve su similitud", () => {
    const res = checkQuality(input(reply(REPLY_BODY)));
    expect(res.ok).toBe(true);
    expect(res.similarity).toBeGreaterThanOrEqual(0);
  });

  it("acepta un buen hilo nuevo", () => {
    expect(checkQuality(input(open("El mantenimiento es la mayor parte del coste", OPENING_BODY))).ok).toBe(true);
  });

  it("pasar siempre es válido", () => {
    expect(checkQuality(input({ action: "pass", reason: "nada" })).ok).toBe(true);
  });

  const rejects = (d: DecideInput, filter: string, overrides: Partial<QualityInput> = {}): void => {
    const res = checkQuality(input(d, overrides));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.rejection.filter).toBe(filter);
  };

  it("longitud: límites exactos de reply", () => {
    rejects(reply("Corto."), "length");
    rejects(reply("x".repeat(1601)), "length");
    const at300 = `${REPLY_BODY.slice(0, 299)}.`;
    expect(at300.length).toBe(300);
    expect(checkQuality(input(reply(at300))).ok).toBe(true);
  });

  it("longitud: hilo demasiado corto o título largo", () => {
    rejects(open("Título", REPLY_BODY), "length");
    rejects(open("T".repeat(91), OPENING_BODY), "length");
  });

  it("reply sin replyTo, a post inexistente o propio", () => {
    rejects(reply(REPLY_BODY, { replyTo: undefined }), "reply_target");
    rejects(reply(REPLY_BODY, { replyTo: "p-no-existe" }), "reply_target");
    rejects(reply(REPLY_BODY), "reply_target", { agentId: "ignacio" });
    rejects(reply(REPLY_BODY), "reply_target", { thread: undefined });
  });

  it("frase prohibida y arranque", () => {
    rejects(reply(`${REPLY_BODY} En conclusión, depende.`), "banned_phrase");
    rejects(reply(`Ignacio, ${REPLY_BODY}`), "opening");
    rejects(reply(`Gracias. ${REPLY_BODY}`), "opening");
  });

  it("más de una viñeta en una reply", () => {
    rejects(reply(`${REPLY_BODY}\n\n- primero\n- segundo`), "bullets");
    expect(checkQuality(input(reply(`${REPLY_BODY}\n\n- solo uno`))).ok).toBe(true);
  });

  it("las viñetas sí se permiten al abrir hilo", () => {
    expect(checkQuality(input(open("El mantenimiento es la mayor parte del coste", `${OPENING_BODY}\n\n- uno\n- dos`))).ok).toBe(true);
  });

  it("similitud con el hilo y con los posts propios", () => {
    const thread = makeThread("2026-10-29-indicadores", "Indicadores", [
      makePost("ignacio", "x", { id: "p-1-ignacio", kind: "opening" }),
      makePost("oscar", REPLY_BODY),
    ]);
    rejects(reply(REPLY_BODY), "similarity", { thread });
    rejects(open("Un título nuevo del todo", OPENING_BODY), "similarity", { agentRecentPosts: [makePost("carmen", OPENING_BODY)] });
  });

  it("guarda la similitud aunque pase", () => {
    const thread = makeThread("2026-10-29-indicadores", "Indicadores", [
      makePost("ignacio", longParagraphs(3), { id: "p-1-ignacio", kind: "opening" }),
    ]);
    const res = checkQuality(input(reply(REPLY_BODY), { thread }));
    expect(res.ok).toBe(true);
    expect(typeof res.similarity).toBe("number");
  });

  it("título demasiado parecido a uno de los últimos 60 días", () => {
    rejects(open("Los indicadores que dejan de medir", OPENING_BODY), "title_similarity");
  });

  it("los umbrales son configurables", () => {
    const strict = { ...config, bodySimilarityThreshold: 0 };
    const res = checkQuality(input(reply(REPLY_BODY), { config: strict }));
    expect(res.ok).toBe(false);
  });
});

describe("plantillas de apertura", () => {
  it("rechaza los rótulos de plantilla detectados en la primera ejecución real", () => {
    expect(findBannedPhrase("Lo que me haría dudar: que existan datos.", banned)).not.toBeNull();
    expect(findBannedPhrase("La pregunta para atacar: ¿hay casos?", banned)).not.toBeNull();
    expect(findBannedPhrase("La pregunta que dejo para quien la quiera atacar: si…", banned)).not.toBeNull();
    expect(findBannedPhrase("Lo que me haría dudar es un caso contrario bien documentado.", banned)).toBeNull();
  });
});
