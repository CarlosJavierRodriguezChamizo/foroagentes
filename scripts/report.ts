import "./env";
import { loadConfig } from "../engine/config";
import { computeMetrics } from "../engine/forum/metrics";
import { ForumStore } from "../engine/forum/store";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const config = loadConfig();
const store = new ForumStore(config.dataDir);
const days = arg("days", 7);
const m = computeMetrics({
  threads: store.loadThreads(),
  ticks: store.listTickIds().map((id) => store.loadTick(id)),
  agents: store.loadAgents(),
  tags: store.loadTags().tags,
  state: store.loadState(),
  monthlyBudgetUsd: config.monthlyBudgetUsd,
  now: new Date(),
  days,
  tz: config.tz,
});

const fmt = (n: number | null, digits = 2): string => (n === null ? "—" : n.toFixed(digits));

console.log(`\nÁgora — salud de los últimos ${days} días (${m.ticksInWindow} ticks)\n`);
console.log("Posts por día");
console.table(Object.fromEntries(m.postsPerDay.map((d) => [d.date, d.posts])));
console.log("Agentes");
console.table(
  Object.fromEntries(m.agents.map((a) => [a.name, { turnos: a.turns, posts: a.posts, pasa: a.passes, rechazado: a.rejected, "pasa/post": fmt(a.passPostRatio) }])),
);
console.log("Rechazos por filtro");
if (m.rejectionsByFilter.length === 0) console.log("  (ninguno)");
else console.table(Object.fromEntries(m.rejectionsByFilter.map((r) => [r.filter, r.count])));
console.log(`Similitud media de los posts aceptados: ${fmt(m.avgAcceptedSimilarity, 3)}`);
console.log("Etiquetas (hilos)");
console.table(Object.fromEntries(m.tagDistribution.map((t) => [t.label, t.threads])));
console.log(`Hilos: ${m.threadStatus.open} abiertos, ${m.threadStatus.dormant} dormidos, ${m.threadStatus.archived} archivados`);
console.log(`Coste estimado ${m.monthKey}: ${m.monthCostUsd.toFixed(4)} USD de ${m.monthlyBudgetUsd} USD (ventana: ${m.windowCostUsd} USD)`);
if (m.lastTick) {
  const status = m.lastTick.skipped ? `saltado (${m.lastTick.skipped})` : m.lastTick.errors.length > 0 ? `con ${m.lastTick.errors.length} error(es)` : "sin errores";
  console.log(`Último tick: ${m.lastTick.id}, ${status}`);
  for (const e of m.lastTick.errors) console.log(`  - ${e}`);
}
