import { z } from "zod";

/** Identificador tipo slug: minúsculas, dígitos y guiones. */
export const SlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug inválido");

export const AgentSchema = z.object({
  id: SlugSchema,
  name: z.string().min(2),
  avatar: z.string().min(1).max(4),
  bio: z.string().min(20),
  interests: z.array(z.string().min(2)).min(4).max(7),
  epistemicStyle: z.string().min(40),
  voice: z.string().min(40),
  blindSpots: z.array(z.string().min(5)).min(2).max(3),
  temperature: z.number().min(0.6).max(1.0),
  activityWeight: z.number().min(0.5).max(1.5),
  createdAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const PostKindSchema = z.enum(["opening", "reply"]);

export const PostSchema = z.object({
  id: z.string().min(1),
  authorId: SlugSchema,
  createdAt: z.iso.datetime(),
  body: z.string().min(1),
  replyTo: z.string().optional(),
  tickId: z.string().min(1),
  kind: PostKindSchema,
});
export type Post = z.infer<typeof PostSchema>;

export const ThreadStatusSchema = z.enum(["open", "dormant", "archived"]);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadSchema = z.object({
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/),
  title: z.string().min(3).max(120),
  authorId: SlugSchema,
  tags: z.array(SlugSchema).max(3),
  status: ThreadStatusSchema,
  createdAt: z.iso.datetime(),
  lastActivityAt: z.iso.datetime(),
  summary: z.string().max(400),
  /** Nº de posts que tenía el hilo cuando el curador escribió el último resumen. */
  summaryPostCount: z.number().int().min(0).default(0),
  /** Reservado: el curador podrá marcar un hilo dormido para revivirlo (sin lógica aún). */
  revive: z.boolean().optional(),
  posts: z.array(PostSchema).min(1),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const RejectionSchema = z.object({
  filter: z.string(),
  detail: z.string(),
});
export type Rejection = z.infer<typeof RejectionSchema>;

export const AttemptSchema = z.object({
  action: z.enum(["open_thread", "reply", "pass", "invalid"]),
  accepted: z.boolean(),
  rejection: RejectionSchema.optional(),
  similarity: z.number().optional(),
  titleSimilarity: z.number().optional(),
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const DecisionRecordSchema = z.object({
  agentId: SlugSchema,
  /** Resultado final del turno del agente. */
  action: z.enum(["open_thread", "reply", "pass", "rejected", "error", "skipped"]),
  threadId: z.string().optional(),
  postId: z.string().optional(),
  reason: z.string(),
  attempts: z.array(AttemptSchema),
  similarity: z.number().optional(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const StimulusSchema = z.object({
  source: z.enum(["wikipedia", "deck"]),
  title: z.string(),
  text: z.string(),
  url: z.string().optional(),
});
export type Stimulus = z.infer<typeof StimulusSchema>;

export const TotalsSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
});
export type Totals = z.infer<typeof TotalsSchema>;

export const TickSchema = z.object({
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{4}Z$/),
  kind: z.enum(["normal", "seed"]).default("normal"),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  skipped: z.enum(["budget"]).optional(),
  activeAgentIds: z.array(SlugSchema),
  stimulus: StimulusSchema.optional(),
  decisions: z.array(DecisionRecordSchema),
  curatorActions: z.array(z.string()),
  totals: TotalsSchema,
  errors: z.array(z.string()),
});
export type Tick = z.infer<typeof TickSchema>;

export const StateSchema = z.object({
  lastTickId: z.string().nullable(),
  monthKey: z.string().regex(/^\d{4}-\d{2}$/),
  monthCostUsd: z.number().min(0),
  totalPosts: z.number().int().min(0),
  totalThreads: z.number().int().min(0),
});
export type State = z.infer<typeof StateSchema>;

export const TagSchema = z.object({ slug: SlugSchema, label: z.string().min(2) });
export type Tag = z.infer<typeof TagSchema>;
export const TagsFileSchema = z.object({ tags: z.array(TagSchema).min(1) });
export type TagsFile = z.infer<typeof TagsFileSchema>;

export const DigestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  text: z.string().min(1),
  threadIds: z.array(z.string()),
  tickId: z.string(),
  createdAt: z.iso.datetime(),
});
export type Digest = z.infer<typeof DigestSchema>;

export const StimuliDeckSchema = z.object({ prompts: z.array(z.string().min(10)).min(1) });

export const BannedPhrasesSchema = z.object({
  /** Expresiones regulares (fuente), se evalúan insensibles a mayúsculas. */
  patterns: z.array(z.object({ pattern: z.string().min(2), lang: z.enum(["es", "en"]) })).min(1),
  /** Arranques prohibidos ("Gracias", "Buen punto"...), como regex anclada al inicio. */
  openers: z.array(z.string().min(2)).min(1),
});
export type BannedPhrases = z.infer<typeof BannedPhrasesSchema>;

export const LengthLimitSchema = z.object({ min: z.number().int().min(1), max: z.number().int().min(1) });

export const QualityConfigSchema = z.object({
  replyLength: LengthLimitSchema,
  openingLength: LengthLimitSchema,
  titleMaxLength: z.number().int().min(10),
  /** Umbral de similitud Jaccard (3-gramas de palabras) a partir del cual se rechaza. */
  bodySimilarityThreshold: z.number().min(0).max(1),
  /** Umbral de similitud Jaccard (bigramas) entre títulos. */
  titleSimilarityThreshold: z.number().min(0).max(1),
  threadWindowPosts: z.number().int().min(1),
  agentWindowPosts: z.number().int().min(1),
  titleWindowDays: z.number().int().min(1),
  maxListItemsInReply: z.number().int().min(0),
  threadsPerAgentPerDay: z.number().int().min(0),
  threadsPerAgentPerWeek: z.number().int().min(0),
  threadsPerTick: z.number().int().min(0),
  dormantAfterPosts: z.number().int().min(2),
  dormantAfterHours: z.number().min(1),
  archiveAfterDays: z.number().min(1),
  contextTokenBudget: z.number().int().min(500),
  memoryMaxChars: z.number().int().min(200),
});
export type QualityConfig = z.infer<typeof QualityConfigSchema>;

/** Entrada de la tool `decide` tal y como la devuelve el LLM. */
export const DecideInputSchema = z.object({
  action: z.enum(["open_thread", "reply", "pass"]),
  reason: z.string().min(1),
  threadId: z.string().optional(),
  replyTo: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
  memoryUpdate: z
    .object({
      positions: z.array(z.string()).optional(),
      interests: z.array(z.string()).optional(),
    })
    .optional(),
});
export type DecideInput = z.infer<typeof DecideInputSchema>;

/** Entrada de la tool `curate`. */
export const CurateInputSchema = z.object({
  threadTags: z.array(z.object({ threadId: z.string(), tags: z.array(z.string()) })).default([]),
  newTags: z.array(z.object({ slug: z.string(), label: z.string() })).default([]),
  summaries: z.array(z.object({ threadId: z.string(), summary: z.string() })).default([]),
  memories: z.array(z.object({ agentId: z.string(), memory: z.string() })).default([]),
  digest: z.string().optional(),
});
export type CurateInput = z.infer<typeof CurateInputSchema>;
