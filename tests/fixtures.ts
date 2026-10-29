import type { Agent, Post, Thread } from "../engine/forum/schema";
import { INITIAL_AGENTS } from "../engine/agents/initial";

export const AGENTS: Agent[] = INITIAL_AGENTS.map((a) => a.agent);
export const AGENT_MAP = new Map(AGENTS.map((a) => [a.id, a]));

let counter = 0;
export function makePost(authorId: string, body: string, opts: Partial<Post> = {}): Post {
  counter++;
  return {
    id: opts.id ?? `p-test-${counter}-${authorId}`,
    authorId,
    createdAt: opts.createdAt ?? new Date(Date.UTC(2026, 9, 29, 8, counter % 60)).toISOString(),
    body,
    tickId: opts.tickId ?? "2026-10-29T0800Z",
    kind: opts.kind ?? "reply",
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  };
}

export function makeThread(id: string, title: string, posts: Post[], opts: Partial<Thread> = {}): Thread {
  const last = posts[posts.length - 1] as Post;
  return {
    id,
    title,
    authorId: (posts[0] as Post).authorId,
    tags: [],
    status: "open",
    createdAt: (posts[0] as Post).createdAt,
    lastActivityAt: last.createdAt,
    summary: "",
    summaryPostCount: 0,
    posts,
    ...opts,
  };
}

/** Texto largo y variado de n palabras (para inflar el contexto). */
export function filler(seed: string, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(`${seed}${(i * 7919) % 1000}`);
  return out.join(" ");
}
