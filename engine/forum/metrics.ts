import type { Agent, Tag, Thread, Tick, State } from "./schema";
import { DAY_MS, localParts } from "./util";

export interface AgentHealth {
  agentId: string;
  name: string;
  turns: number;
  posts: number;
  passes: number;
  rejected: number;
  /** pasa / publica: >1 significa que pasa más de lo que publica. */
  passPostRatio: number | null;
}

export interface HealthMetrics {
  days: number;
  postsPerDay: { date: string; posts: number }[];
  agents: AgentHealth[];
  rejectionsByFilter: { filter: string; count: number }[];
  avgAcceptedSimilarity: number | null;
  tagDistribution: { slug: string; label: string; threads: number }[];
  threadStatus: { open: number; dormant: number; archived: number };
  monthCostUsd: number;
  monthlyBudgetUsd: number;
  monthKey: string;
  lastTick: { id: string; errors: string[]; skipped?: string; finishedAt: string } | null;
  ticksInWindow: number;
  windowCostUsd: number;
}

export interface MetricsInput {
  threads: Thread[];
  ticks: Tick[];
  agents: Agent[];
  tags: Tag[];
  state: State;
  monthlyBudgetUsd: number;
  now: Date;
  days: number;
  tz: string;
}

export function computeMetrics(input: MetricsInput): HealthMetrics {
  const { threads, agents, tags, state, now, days, tz } = input;
  const since = now.getTime() - days * DAY_MS;
  const ticks = input.ticks.filter((t) => !t.dryRun && new Date(t.startedAt).getTime() >= since);

  const perDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) perDay.set(localParts(new Date(now.getTime() - i * DAY_MS), tz).date, 0);
  for (const t of threads)
    for (const p of t.posts) {
      if (new Date(p.createdAt).getTime() < since) continue;
      const d = localParts(new Date(p.createdAt), tz).date;
      if (perDay.has(d)) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }

  const agentStats = new Map<string, AgentHealth>(
    agents.map((a) => [a.id, { agentId: a.id, name: a.name, turns: 0, posts: 0, passes: 0, rejected: 0, passPostRatio: null }]),
  );
  const rejections = new Map<string, number>();
  const similarities: number[] = [];
  for (const tick of ticks) {
    for (const d of tick.decisions) {
      const s = agentStats.get(d.agentId);
      if (s && d.action !== "skipped") {
        s.turns++;
        if (d.postId) s.posts++;
        else if (d.action === "pass") s.passes++;
        else if (d.action === "rejected") s.rejected++;
      }
      for (const a of d.attempts) if (!a.accepted && a.rejection) rejections.set(a.rejection.filter, (rejections.get(a.rejection.filter) ?? 0) + 1);
      if (d.postId && typeof d.similarity === "number") similarities.push(d.similarity);
    }
  }
  for (const s of agentStats.values()) s.passPostRatio = s.posts > 0 ? Math.round((s.passes / s.posts) * 100) / 100 : null;

  const tagCounts = new Map<string, number>();
  for (const t of threads) for (const tag of t.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const label = (slug: string): string => tags.find((t) => t.slug === slug)?.label ?? slug;

  const all = [...input.ticks].filter((t) => !t.dryRun).sort((a, b) => a.id.localeCompare(b.id));
  const last = all[all.length - 1];
  return {
    days,
    postsPerDay: [...perDay.entries()].map(([date, posts]) => ({ date, posts })),
    agents: [...agentStats.values()],
    rejectionsByFilter: [...rejections.entries()].map(([filter, count]) => ({ filter, count })).sort((a, b) => b.count - a.count),
    avgAcceptedSimilarity: similarities.length > 0 ? Math.round((similarities.reduce((a, b) => a + b, 0) / similarities.length) * 1000) / 1000 : null,
    tagDistribution: [...tagCounts.entries()].map(([slug, n]) => ({ slug, label: label(slug), threads: n })).sort((a, b) => b.threads - a.threads),
    threadStatus: {
      open: threads.filter((t) => t.status === "open").length,
      dormant: threads.filter((t) => t.status === "dormant").length,
      archived: threads.filter((t) => t.status === "archived").length,
    },
    monthCostUsd: state.monthCostUsd,
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    monthKey: state.monthKey,
    lastTick: last ? { id: last.id, errors: last.errors, skipped: last.skipped, finishedAt: last.finishedAt } : null,
    ticksInWindow: ticks.length,
    windowCostUsd: Math.round(ticks.reduce((s, t) => s + t.totals.estimatedCostUsd, 0) * 1e4) / 1e4,
  };
}
