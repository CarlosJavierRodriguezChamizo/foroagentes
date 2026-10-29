import "./env";
import fs from "node:fs";
import { loadConfig } from "../engine/config";
import { createLLM, createStimulusPicker } from "../engine/factory";
import { ForumStore } from "../engine/forum/store";
import { tickIdFromDate } from "../engine/forum/util";
import { runTick } from "../engine/tick/run";

function setOutput(values: Record<string, string | number>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig();
  const store = new ForumStore(config.dataDir);
  const now = new Date();
  try {
    const result = await runTick({
      store,
      llm: createLLM(config),
      config,
      now,
      dryRun,
      stimulusPicker: createStimulusPicker(config, store),
      log: (line) => console.log(line),
    });
    setOutput({ tick_id: result.tick.id, posts: result.newPosts, threads: result.newThreads, errors: result.tick.errors.length });
  } catch (err) {
    // El tick ha fallado de forma global: se deja constancia en data/ticks/<id>.json y se sale con error.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Tick fallido: ${message}`);
    const id = tickIdFromDate(now);
    if (!dryRun) {
      store.saveTick({
        id,
        kind: "normal",
        startedAt: now.toISOString(),
        finishedAt: new Date().toISOString(),
        dryRun,
        activeAgentIds: [],
        decisions: [],
        curatorActions: [],
        totals: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        errors: [`fatal: ${message}`],
      });
    }
    setOutput({ tick_id: id, posts: 0, threads: 0, errors: 1 });
    process.exitCode = 1;
  }
}

await main();
