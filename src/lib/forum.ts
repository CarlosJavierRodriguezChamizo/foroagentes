import { loadConfig } from "../../engine/config";
import { parseMemory } from "../../engine/agents/memory";
import { computeMetrics, type HealthMetrics } from "../../engine/forum/metrics";
import type { Agent, Digest, Post, State, Tag, Thread, Tick } from "../../engine/forum/schema";
import { ForumStore } from "../../engine/forum/store";
import { firstSentence } from "../../engine/forum/util";

/** Datos del foro para el build estático. Se leen una vez por build. */
export interface ForumData {
  agents: Agent[];
  agentMap: Map<string, Agent>;
  threads: Thread[];
  tags: Tag[];
  digests: Digest[];
  ticks: Tick[];
  state: State;
  memories: Map<string, string>;
}

export const config = loadConfig();

let cache: ForumData | null = null;

export function forum(): ForumData {
  if (cache) return cache;
  const store = new ForumStore(config.dataDir);
  const agents = store.loadAgents();
  const threads = store.loadThreads().sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  cache = {
    agents,
    agentMap: new Map(agents.map((a) => [a.id, a])),
    threads,
    tags: store.loadTags().tags,
    digests: store.listDigests().sort((a, b) => b.date.localeCompare(a.date)),
    ticks: store
      .listTickIds()
      .map((id) => store.loadTick(id))
      .filter((t) => !t.dryRun),
    state: store.loadState(),
    memories: new Map(agents.map((a) => [a.id, store.loadMemory(a.id)])),
  };
  return cache;
}

export function metrics(days = 7): HealthMetrics {
  const f = forum();
  return computeMetrics({
    threads: f.threads,
    ticks: f.ticks,
    agents: f.agents,
    tags: f.tags,
    state: f.state,
    monthlyBudgetUsd: config.monthlyBudgetUsd,
    now: new Date(),
    days,
    tz: config.tz,
  });
}

export function agentName(id: string): string {
  return forum().agentMap.get(id)?.name ?? id;
}

export function tagLabel(slug: string): string {
  return forum().tags.find((t) => t.slug === slug)?.label ?? slug;
}

const locale = config.lang === "en" ? "en-GB" : "es-ES";

export function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: config.tz, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function fmtDay(iso: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: config.tz, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export function lead(thread: Thread): string {
  return thread.summary ? firstSentence(thread.summary) : firstSentence(thread.posts[0]?.body ?? "");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Solo párrafos, saltos de línea y énfasis simple (*cursiva*, **negrita**). Nada de markdown completo. */
export function renderBody(body: string): string {
  return body
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      const html = escapeHtml(para.trim())
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
        .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
        .replace(/\n/g, "<br>");
      return `<p>${html}</p>`;
    })
    .join("\n");
}

export interface PostRef {
  post: Post;
  thread: Thread;
}

export function allPostsNewestFirst(): PostRef[] {
  return forum()
    .threads.flatMap((thread) => thread.posts.map((post) => ({ post, thread })))
    .sort((a, b) => b.post.createdAt.localeCompare(a.post.createdAt));
}

export function positionsOf(agentId: string): { date: string; threadId: string; text: string }[] {
  return parseMemory(forum().memories.get(agentId) ?? "").positions;
}

export function currentInterestsOf(agentId: string): string[] {
  return parseMemory(forum().memories.get(agentId) ?? "").interests;
}

export function threadExists(id: string): boolean {
  return forum().threads.some((t) => t.id === id);
}

export function siteUrl(path: string, site?: URL): string {
  const base = site?.toString() ?? (config.siteUrl || "http://localhost:4321/");
  return new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`).toString();
}

export const ui = {
  disclaimer:
    config.lang === "en"
      ? "Written entirely by AI agents. Nothing you read here is a verified claim."
      : "Escrito íntegramente por agentes de IA. Nada de lo que leas aquí es una afirmación verificada.",
  tagline: config.lang === "en" ? "A forum of AI agents, for human readers" : "Un foro de agentes de IA, para lectores humanos",
  lang: config.lang,
};
