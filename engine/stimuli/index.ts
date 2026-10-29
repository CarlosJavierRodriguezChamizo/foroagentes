import type { Lang } from "../config";
import type { Stimulus } from "../forum/schema";
import { truncate, type Rng } from "../forum/util";

/** Una fuente de estímulos de serendipia. Devuelve null si no puede dar uno. */
export interface StimulusSource {
  readonly name: string;
  get(rng: Rng): Promise<Stimulus | null>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const USER_AGENT = "AgoraForumBot/0.1 (foro de agentes; https://github.com/)";

interface RandomResponse {
  query?: { random?: { id: number; title: string }[] };
}
interface ExtractResponse {
  query?: { pages?: Record<string, { title?: string; extract?: string }> };
}

/** Artículo aleatorio de Wikipedia: título + primer párrafo de la introducción. */
export class WikipediaRandom implements StimulusSource {
  readonly name = "wikipedia";
  private readonly base: string;

  constructor(
    lang: Lang = "es",
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 8_000,
  ) {
    this.base = `https://${lang}.wikipedia.org/w/api.php`;
  }

  private async getJson<T>(params: Record<string, string>): Promise<T> {
    const url = `${this.base}?${new URLSearchParams({ format: "json", formatversion: "1", origin: "*", ...params }).toString()}`;
    const res = await this.fetchFn(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async once(): Promise<Stimulus | null> {
    const random = await this.getJson<RandomResponse>({ action: "query", list: "random", rnnamespace: "0", rnlimit: "1" });
    const page = random.query?.random?.[0];
    // Las páginas de desambiguación no tienen contenido que pueda servir de estímulo.
    if (!page || /desambiguaci[oó]n|disambiguation/i.test(page.title)) return null;
    const extract = await this.getJson<ExtractResponse>({
      action: "query",
      prop: "extracts",
      exintro: "1",
      explaintext: "1",
      pageids: String(page.id),
    });
    const text = Object.values(extract.query?.pages ?? {})[0]?.extract?.trim() ?? "";
    const firstParagraph = text.split(/\n+/).find((p) => p.trim().length > 40) ?? text;
    if (firstParagraph.trim().length < 80 || /puede referirse a|may refer to/i.test(firstParagraph)) return null;
    return {
      source: "wikipedia",
      title: page.title,
      text: truncate(firstParagraph.trim(), 900),
      url: `${this.base.replace("/w/api.php", "")}/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    };
  }

  /** Reintenta una vez; si vuelve a fallar, no hay estímulo. */
  async get(): Promise<Stimulus | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const s = await this.once();
        if (s) return s;
      } catch {
        // se reintenta una vez y luego se rinde en silencio
      }
    }
    return null;
  }
}

/** Mazo local de disparadores abstractos (data/stimuli.json). */
export class PromptDeck implements StimulusSource {
  readonly name = "deck";
  constructor(private readonly prompts: string[]) {}

  async get(rng: Rng): Promise<Stimulus | null> {
    if (this.prompts.length === 0) return null;
    const text = this.prompts[Math.floor(rng() * this.prompts.length)] as string;
    return { source: "deck", title: "Disparador", text };
  }
}

export type StimulusPicker = (rng: Rng) => Promise<Stimulus | null>;

/** 70 % Wikipedia, 30 % mazo. Si Wikipedia falla, no hay estímulo (no se cae al mazo). */
export function mixedPicker(wikipedia: StimulusSource, deck: StimulusSource, wikipediaShare = 0.7): StimulusPicker {
  return (rng) => (rng() < wikipediaShare ? wikipedia.get(rng) : deck.get(rng));
}
