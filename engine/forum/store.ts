import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  AgentSchema,
  BannedPhrasesSchema,
  DigestSchema,
  QualityConfigSchema,
  StateSchema,
  StimuliDeckSchema,
  TagsFileSchema,
  ThreadSchema,
  TickSchema,
  type Agent,
  type BannedPhrases,
  type Digest,
  type QualityConfig,
  type State,
  type TagsFile,
  type Thread,
  type Tick,
} from "./schema";
import { monthKeyOf } from "./util";

/**
 * Escritura atómica: se escribe a un temporal en el mismo directorio y se renombra.
 * `rename` es atómico dentro del mismo sistema de ficheros, así que nunca queda un JSON a medias.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeJsonAtomic(filePath: string, data: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson<S extends z.ZodType>(filePath: string, schema: S): z.output<S> {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`JSON inválido en ${filePath}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Esquema inválido en ${filePath}: ${result.error.message}`);
  }
  return result.data;
}

function listJson(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.includes(".tmp-"))
    .sort();
}

/** Acceso tipado al directorio `data/`. Toda lectura se valida con zod. */
export class ForumStore {
  constructor(readonly dataDir: string) {}

  private p(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  // --- Agentes y memoria -------------------------------------------------
  loadAgents(): Agent[] {
    const dir = this.p("agents");
    return listJson(dir).map((f) => readJson(path.join(dir, f), AgentSchema));
  }

  saveAgent(agent: Agent): void {
    writeJsonAtomic(this.p("agents", `${agent.id}.json`), AgentSchema.parse(agent));
  }

  memoryPath(agentId: string): string {
    return this.p("agents", `${agentId}.memory.md`);
  }

  loadMemory(agentId: string): string {
    const file = this.memoryPath(agentId);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  saveMemory(agentId: string, memory: string): void {
    writeFileAtomic(this.memoryPath(agentId), memory.endsWith("\n") ? memory : `${memory}\n`);
  }

  // --- Hilos -------------------------------------------------------------
  loadThreads(): Thread[] {
    const dir = this.p("threads");
    return listJson(dir).map((f) => readJson(path.join(dir, f), ThreadSchema));
  }

  saveThread(thread: Thread): void {
    writeJsonAtomic(this.p("threads", `${thread.id}.json`), ThreadSchema.parse(thread));
  }

  // --- Ticks -------------------------------------------------------------
  listTickIds(): string[] {
    return listJson(this.p("ticks")).map((f) => f.replace(/\.json$/, ""));
  }

  hasTick(id: string): boolean {
    return fs.existsSync(this.p("ticks", `${id}.json`));
  }

  loadTick(id: string): Tick {
    return readJson(this.p("ticks", `${id}.json`), TickSchema);
  }

  /** Los últimos `n` ticks, del más antiguo al más reciente. */
  loadRecentTicks(n: number): Tick[] {
    return this.listTickIds()
      .slice(-n)
      .map((id) => this.loadTick(id));
  }

  saveTick(tick: Tick): void {
    writeJsonAtomic(this.p("ticks", `${tick.id}.json`), TickSchema.parse(tick));
  }

  // --- Estado global -----------------------------------------------------
  loadState(now: Date = new Date()): State {
    const file = this.p("state.json");
    if (!fs.existsSync(file)) {
      return { lastTickId: null, monthKey: monthKeyOf(now), monthCostUsd: 0, totalPosts: 0, totalThreads: 0 };
    }
    return readJson(file, StateSchema);
  }

  saveState(state: State): void {
    writeJsonAtomic(this.p("state.json"), StateSchema.parse(state));
  }

  // --- Vocabulario, digests y configuración editable ---------------------
  loadTags(): TagsFile {
    return readJson(this.p("tags.json"), TagsFileSchema);
  }

  saveTags(tags: TagsFile): void {
    writeJsonAtomic(this.p("tags.json"), TagsFileSchema.parse(tags));
  }

  listDigests(): Digest[] {
    const dir = this.p("digests");
    return listJson(dir).map((f) => readJson(path.join(dir, f), DigestSchema));
  }

  hasDigest(date: string): boolean {
    return fs.existsSync(this.p("digests", `${date}.json`));
  }

  saveDigest(digest: Digest): void {
    writeJsonAtomic(this.p("digests", `${digest.date}.json`), DigestSchema.parse(digest));
  }

  loadStimuliDeck(): string[] {
    return readJson(this.p("stimuli.json"), StimuliDeckSchema).prompts;
  }

  loadBannedPhrases(): BannedPhrases {
    return readJson(this.p("banned-phrases.json"), BannedPhrasesSchema);
  }

  loadQualityConfig(): QualityConfig {
    return readJson(this.p("quality.json"), QualityConfigSchema);
  }
}
