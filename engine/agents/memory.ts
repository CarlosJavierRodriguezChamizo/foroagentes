/**
 * Memoria de un agente: markdown con dos secciones.
 *
 *   ## Posiciones que mantengo
 *   - (2026-10-29, 2026-10-29-hilo-x) Creo que…
 *   ## Cosas que me interesan ahora
 *   - tema
 */

export const POSITIONS_HEADING = "## Posiciones que mantengo";
export const INTERESTS_HEADING = "## Cosas que me interesan ahora";

export interface Position {
  date: string;
  threadId: string;
  text: string;
}

export interface Memory {
  positions: Position[];
  interests: string[];
}

const POSITION_RE = /^-\s*\((\d{4}-\d{2}-\d{2}),\s*([^)]+)\)\s*(.+)$/;

export function parseMemory(markdown: string): Memory {
  const memory: Memory = { positions: [], interests: [] };
  let section: "positions" | "interests" | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      section = line === POSITIONS_HEADING ? "positions" : line === INTERESTS_HEADING ? "interests" : null;
      continue;
    }
    if (!line.startsWith("-") || section === null) continue;
    if (section === "positions") {
      const m = POSITION_RE.exec(line);
      if (m) memory.positions.push({ date: m[1] as string, threadId: (m[2] as string).trim(), text: (m[3] as string).trim() });
      else memory.positions.push({ date: "0000-00-00", threadId: "?", text: line.replace(/^-\s*/, "") });
    } else {
      const text = line.replace(/^-\s*/, "").trim();
      if (text) memory.interests.push(text);
    }
  }
  return memory;
}

export function serializeMemory(memory: Memory): string {
  const lines = [POSITIONS_HEADING];
  for (const p of memory.positions) lines.push(`- (${p.date}, ${p.threadId}) ${p.text}`);
  lines.push("", INTERESTS_HEADING);
  for (const i of memory.interests) lines.push(`- ${i}`);
  return `${lines.join("\n")}\n`;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface MemoryUpdate {
  positions?: string[];
  interests?: string[];
}

/**
 * Aplica la actualización que propone el agente. Las posiciones nuevas se añaden con fecha e id
 * de hilo; si ya existía una casi idéntica, se sustituye (cambio de matiz). Los intereses
 * "ya no: X" eliminan X.
 */
export function applyMemoryUpdate(markdown: string, update: MemoryUpdate | undefined, date: string, threadId: string): string {
  if (!update) return markdown;
  const memory = parseMemory(markdown);
  for (const raw of update.positions ?? []) {
    const text = raw.trim().replace(/\s+/g, " ").slice(0, 240);
    if (!text) continue;
    const idx = memory.positions.findIndex((p) => norm(p.text) === norm(text));
    if (idx >= 0) memory.positions.splice(idx, 1);
    memory.positions.push({ date, threadId, text });
  }
  for (const raw of update.interests ?? []) {
    const text = raw.trim().slice(0, 120);
    const drop = /^ya no:\s*(.+)$/i.exec(text) ?? /^no longer:\s*(.+)$/i.exec(text);
    if (drop) {
      const target = norm(drop[1] as string);
      memory.interests = memory.interests.filter((i) => !norm(i).includes(target) && !target.includes(norm(i)));
    } else if (text && !memory.interests.some((i) => norm(i) === norm(text))) {
      memory.interests.push(text);
    }
  }
  return serializeMemory(memory);
}

/**
 * Compresión determinista (respaldo del curador): conserva las posiciones más recientes y las
 * citadas en más hilos, y recorta intereses antiguos hasta caber en `maxChars`.
 */
export function compressMemoryLocally(markdown: string, maxChars: number, threadCitations: Map<string, number> = new Map()): string {
  const memory = parseMemory(markdown);
  const score = (p: Position, index: number): number => (threadCitations.get(p.threadId) ?? 0) * 2 + index / Math.max(1, memory.positions.length);
  while (serializeMemory(memory).length > maxChars) {
    if (memory.interests.length > 3) {
      memory.interests.shift();
      continue;
    }
    if (memory.positions.length > 2) {
      let worst = 0;
      for (let i = 1; i < memory.positions.length; i++) {
        if (score(memory.positions[i] as Position, i) < score(memory.positions[worst] as Position, worst)) worst = i;
      }
      memory.positions.splice(worst, 1);
      continue;
    }
    if (memory.interests.length > 0) {
      memory.interests.shift();
      continue;
    }
    // Último recurso: acortar textos.
    memory.positions = memory.positions.map((p) => ({ ...p, text: p.text.slice(0, Math.max(40, Math.floor(p.text.length * 0.8))) }));
    if (memory.positions.every((p) => p.text.length <= 40)) break;
  }
  return serializeMemory(memory);
}

export function initialMemory(positions: string[], interests: string[], date: string): string {
  return serializeMemory({
    positions: positions.map((text) => ({ date, threadId: "inicial", text })),
    interests,
  });
}
