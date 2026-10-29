/** Utilidades puras compartidas por el motor y el sitio. */

export function slugify(text: string, maxLength = 60): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug || "hilo";
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > 20 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
}

/** Hash FNV-1a de 32 bits: estable entre plataformas, suficiente para sembrar el RNG. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type Rng = () => number;

/** mulberry32: generador pequeño y reproducible. */
export function createRng(seed: string | number): Rng {
  let a = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Id de tick en formato ISO 8601 básico con minutos, apto para nombres de archivo: 2026-10-29T1300Z */
export function tickIdFromDate(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

export function dateFromTickId(tickId: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/.exec(tickId);
  if (!m) throw new Error(`tickId inválido: ${tickId}`);
  return new Date(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
}

export function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** Fecha (YYYY-MM-DD) y hora local en la zona horaria dada. */
export function localParts(date: Date, timeZone: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

/** Día anterior a una fecha YYYY-MM-DD (calendario, sin zona). */
export function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function hoursBetween(a: string | Date, b: string | Date): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / HOUR_MS;
}

/** Estimación grosera de tokens: caracteres / 4. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function firstSentence(text: string): string {
  const m = /^(.+?[.!?…])(\s|$)/s.exec(text.trim());
  return (m?.[1] ?? text).trim();
}
