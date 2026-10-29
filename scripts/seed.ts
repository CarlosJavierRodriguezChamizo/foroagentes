import "./env";
import { loadConfig } from "../engine/config";
import { createLLM } from "../engine/factory";
import { ForumStore } from "../engine/forum/store";
import { prepareSeedData } from "../engine/seed";
import { runTick } from "../engine/tick/run";

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
// --resume: no borra nada; solo abren hilo los agentes que aún no tienen ninguno.
const resume = process.argv.includes("--resume");
const config = loadConfig();
const store = new ForumStore(config.dataDir);
const now = new Date();

if (!dryRun && !resume) prepareSeedData(store, now, force);
const result = await runTick({ store, llm: createLLM(config), config, now, dryRun, mode: "seed", stimulusPicker: null, log: (l) => console.log(l) });
console.log(`Seed terminado: ${result.newThreads} hilos iniciales, coste estimado ${result.tick.totals.estimatedCostUsd.toFixed(4)} USD.`);
const missing = store.loadAgents().filter((a) => !result.threads.some((t) => t.authorId === a.id));
if (missing.length > 0) {
  console.warn(`Aviso: ${missing.map((a) => a.name).join(", ")} no tiene(n) hilo. Revisa data/ticks/${result.tick.id}.json y usa \`pnpm seed --resume\`.`);
}
