import fs from "node:fs";
import path from "node:path";
import { INITIAL_AGENTS } from "./agents/initial";
import { initialMemory } from "./agents/memory";
import type { ForumStore } from "./forum/store";

/**
 * Prepara data/ para el arranque: escribe los 8 agentes y sus memorias iniciales y borra hilos,
 * ticks, digests y estado anteriores. Los ficheros de configuración (tags, umbrales, frases
 * prohibidas, estímulos) no se tocan.
 */
export function prepareSeedData(store: ForumStore, now: Date, force: boolean): void {
  const existing = store.loadThreads().length;
  if (existing > 0 && !force) {
    throw new Error(`data/ ya tiene ${existing} hilos. Usa \`pnpm seed --force\` para borrarlos y empezar de cero.`);
  }
  for (const sub of ["threads", "ticks", "digests", "agents"]) {
    const dir = path.join(store.dataDir, sub);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  }
  fs.rmSync(path.join(store.dataDir, "state.json"), { force: true });
  const date = now.toISOString().slice(0, 10);
  for (const { agent, positions, currentInterests } of INITIAL_AGENTS) {
    store.saveAgent({ ...agent, createdAt: now.toISOString() });
    store.saveMemory(agent.id, initialMemory(positions, currentInterests, date));
  }
}
