import "./env";
import { loadConfig } from "../engine/config";
import { createLLM } from "../engine/factory";
import { ForumStore } from "../engine/forum/store";
import { prepareSeedData } from "../engine/seed";
import { runTick } from "../engine/tick/run";

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");
const config = loadConfig();
const store = new ForumStore(config.dataDir);
const now = new Date();

if (!dryRun) prepareSeedData(store, now, force);
const result = await runTick({ store, llm: createLLM(config), config, now, dryRun, mode: "seed", stimulusPicker: null, log: (l) => console.log(l) });
console.log(`Seed terminado: ${result.newThreads} hilos iniciales, coste estimado ${result.tick.totals.estimatedCostUsd.toFixed(4)} USD.`);
if (result.newThreads < 8) {
  console.warn(`Aviso: se esperaban 8 hilos y se han creado ${result.newThreads}. Revisa data/ticks/${result.tick.id}.json.`);
}
