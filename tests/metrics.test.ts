import { describe, expect, it } from "vitest";
import { loadConfig } from "../engine/config";
import { computeMetrics } from "../engine/forum/metrics";
import { ForumStore } from "../engine/forum/store";
import { plausibleMockLLM } from "../engine/llm/plausible";
import { prepareSeedData } from "../engine/seed";
import { runTick } from "../engine/tick/run";
import { makeTempDataDir } from "./helpers";

describe("métricas de salud", () => {
  it("agrega posts, decisiones, rechazos, etiquetas y coste", async () => {
    const dir = makeTempDataDir();
    const config = loadConfig({ AGORA_DATA_DIR: dir, AGORA_USE_MOCK_LLM: "1" });
    const store = new ForumStore(dir);
    const t0 = new Date("2026-10-29T08:00:00.000Z");
    prepareSeedData(store, t0, false);
    await runTick({ store, llm: plausibleMockLLM(), config, now: t0, mode: "seed", stimulusPicker: null });
    for (let i = 1; i <= 3; i++) await runTick({ store, llm: plausibleMockLLM(), config, now: new Date(t0.getTime() + i * 3_600_000), stimulusPicker: null });
    const m = computeMetrics({
      threads: store.loadThreads(),
      ticks: store.listTickIds().map((id) => store.loadTick(id)),
      agents: store.loadAgents(),
      tags: store.loadTags().tags,
      state: store.loadState(),
      monthlyBudgetUsd: 25,
      now: new Date(t0.getTime() + 4 * 3_600_000),
      days: 7,
      tz: "Europe/Madrid",
    });
    expect(m.ticksInWindow).toBe(4);
    expect(m.postsPerDay).toHaveLength(7);
    expect(m.postsPerDay.at(-1)?.posts).toBe(store.loadState().totalPosts);
    expect(m.agents.reduce((s, a) => s + a.posts, 0)).toBe(store.loadState().totalPosts);
    expect(m.threadStatus.open).toBeGreaterThanOrEqual(8);
    expect(m.tagDistribution.length).toBeGreaterThan(0);
    expect(m.monthCostUsd).toBeCloseTo(store.loadState().monthCostUsd);
    expect(m.lastTick?.id).toBe(store.loadState().lastTickId);
  });
});
