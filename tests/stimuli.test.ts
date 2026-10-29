import { describe, expect, it } from "vitest";
import { createRng } from "../engine/forum/util";
import { mixedPicker, PromptDeck, WikipediaRandom, type FetchLike, type StimulusSource } from "../engine/stimuli";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function wikiFetch(): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (url.includes("list=random")) return okResponse({ query: { random: [{ id: 42, title: "Puente colgante" }] } });
    return okResponse({ query: { pages: { "42": { title: "Puente colgante", extract: "Un puente colgante es un puente sostenido por un arco invertido formado por cables.\nSegundo párrafo." } } } });
  };
  return { fetch, urls };
}

describe("estímulos", () => {
  it("WikipediaRandom devuelve título y primer párrafo con la API indicada", async () => {
    const { fetch, urls } = wikiFetch();
    const s = await new WikipediaRandom("es", fetch).get();
    expect(s?.source).toBe("wikipedia");
    expect(s?.title).toBe("Puente colgante");
    expect(s?.text).toMatch(/^Un puente colgante/);
    expect(s?.text).not.toContain("Segundo párrafo");
    expect(urls[0]).toContain("es.wikipedia.org");
    expect(urls[0]).toContain("rnnamespace=0");
    expect(urls[1]).toContain("exintro=1");
    expect(urls[1]).toContain("explaintext=1");
  });

  it("reintenta una vez y si vuelve a fallar no hay estímulo (red desactivada)", async () => {
    let calls = 0;
    const offline: FetchLike = async () => {
      calls++;
      throw new Error("ENOTFOUND");
    };
    expect(await new WikipediaRandom("es", offline).get()).toBeNull();
    expect(calls).toBe(2);
  });

  it("se recupera si el primer intento falla y el segundo funciona", async () => {
    const { fetch } = wikiFetch();
    let first = true;
    const flaky: FetchLike = async (url, init) => {
      if (first) {
        first = false;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return fetch(url, init);
    };
    expect((await new WikipediaRandom("es", flaky).get())?.title).toBe("Puente colgante");
  });

  it("descarta desambiguaciones y extractos vacíos, y reintenta", async () => {
    const urls: string[] = [];
    const disamb: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes("list=random")) return okResponse({ query: { random: [{ id: 1, title: "Westland (desambiguación)" }] } });
      return okResponse({ query: { pages: { "1": { extract: "Westland puede referirse a:" } } } });
    };
    expect(await new WikipediaRandom("es", disamb).get()).toBeNull();
    expect(urls.filter((u) => u.includes("list=random"))).toHaveLength(2);
  });

  it("PromptDeck elige de forma reproducible", async () => {
    const deck = new PromptDeck(["uno disparador", "dos disparador", "tres disparador"]);
    const a = await deck.get(createRng("k"));
    const b = await deck.get(createRng("k"));
    expect(a).toEqual(b);
    expect(a?.source).toBe("deck");
  });

  it("mezcla 70/30 y no cae al mazo si Wikipedia falla", async () => {
    const wiki: StimulusSource = { name: "wikipedia", get: async () => null };
    const deck = new PromptDeck(["solo disparador"]);
    const picker = mixedPicker(wiki, deck);
    let deckCount = 0;
    let none = 0;
    const rng = createRng("mezcla");
    for (let i = 0; i < 1000; i++) {
      const s = await picker(rng);
      if (s?.source === "deck") deckCount++;
      if (s === null) none++;
    }
    expect(deckCount).toBeGreaterThan(240);
    expect(deckCount).toBeLessThan(360);
    expect(none).toBe(1000 - deckCount);
  });
});
