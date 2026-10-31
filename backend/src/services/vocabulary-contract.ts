import {z} from "zod"

export const VOCABULARY_BATCH_SCHEMA_VERSION = 1 as const

const IsoTime = z.string().datetime({offset: true})
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const VocabularyContextSchema = z.object({
  text: z.string().min(1).max(500),
  capturedAt: IsoTime,
  /** Stable only within this source day; inferred from gaps longer than 30 minutes. */
  sessionId: z.string().min(1).max(40),
})
export type VocabularyContext = z.infer<typeof VocabularyContextSchema>

export const VocabularyCandidateSchema = z.object({
  word: z.string().trim().min(1).max(40),
  pinyin: z.string().trim().min(1).max(160),
  english: z.string().trim().min(1).max(240),
  /** LinkLingo's Chinese frequency corpus rank, or null when the phrase is absent. */
  corpusRank: z.number().int().positive().nullable(),
  totalAppearances: z.number().int().positive(),
  distinctSessions: z.number().int().positive(),
  contexts: z.array(VocabularyContextSchema).min(1).max(8),
  reasons: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
  confidence: z.enum(["high", "medium", "low"]),
})
export type VocabularyCandidate = z.infer<typeof VocabularyCandidateSchema>

/** Rich Link Lingo record persisted before any delivery attempt. */
export const VocabularyBatchSchema = z.object({
  schemaVersion: z.literal(VOCABULARY_BATCH_SCHEMA_VERSION),
  source: z.literal("linklingo"),
  batchId: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
  localDate: LocalDate,
  timezone: z.literal("Asia/Shanghai"),
  generatedAt: IsoTime,
  transcriptStartAt: IsoTime,
  transcriptEndAt: IsoTime,
  transcriptCount: z.number().int().positive(),
  inferredSessionCount: z.number().int().positive(),
  candidates: z.array(VocabularyCandidateSchema).max(500),
})
export type VocabularyBatch = z.infer<typeof VocabularyBatchSchema>

/** Narrow wire contract expected by Mandarin's vocabulary import endpoint. */
export const MandarinVocabularyCandidateSchema = z.object({
  word: z.string(),
  normalizedWord: z.string().optional(),
  pinyin: z.string(),
  meaning: z.string(),
  situation: z.string(),
  count: z.number().int().positive(),
  sessionIds: z.array(z.string()),
  contexts: z.array(z.string()),
  rank: z.number().int().positive().nullable(),
  reasons: z.array(z.string()),
})
export type MandarinVocabularyCandidate = z.infer<typeof MandarinVocabularyCandidateSchema>

export const MandarinVocabularyBatchRequestSchema = z.object({
  schemaVersion: z.literal(VOCABULARY_BATCH_SCHEMA_VERSION),
  batchId: z.string(),
  sourceDay: LocalDate,
  candidates: z.array(MandarinVocabularyCandidateSchema),
})
export type MandarinVocabularyBatchRequest = z.infer<typeof MandarinVocabularyBatchRequestSchema>

/**
 * Idempotent retries receive Mandarin's original response. Candidate contents
 * belong to Mandarin; Link Lingo only needs the matching batch id as commit proof.
 */
export const MandarinVocabularyBatchResponseSchema = z.object({
  batchId: z.string(),
  candidates: z.array(z.unknown()),
})
export type MandarinVocabularyBatchResponse = z.infer<typeof MandarinVocabularyBatchResponseSchema>
