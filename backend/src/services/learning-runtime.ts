import type {Context} from "hono"

import {createLogger} from "../observability/logger"
import type {SourceIdentity} from "../vendor/mandarin-contract"
import {S3ObjectStore} from "./tape-s3"
import {LearningService, learningConfigFromEnv, configProblem} from "./learning-outbox"
import {VocabularyScanner} from "./vocabulary-scan"

const log = createLogger("learning")

let service: LearningService | null = null
let vocabularyScanner: VocabularyScanner | null = null

export function getLearningService(): LearningService | null {
  return service
}

export function getVocabularyScanner(): VocabularyScanner | null {
  return vocabularyScanner
}

/** Tests and the e2e harness install their own service. */
export function setLearningService(next: LearningService | null): void {
  service?.stop()
  service = next
}

/** Tests can expose a scanner to the authenticated operator query route. */
export function setVocabularyScanner(next: VocabularyScanner | null): void {
  vocabularyScanner?.stop()
  vocabularyScanner = next
}

/**
 * Starts learning delivery when it is enabled and fully configured. A missing
 * bucket or key leaves capture off with a visible reason; it never breaks
 * live glossing.
 */
export function startLearning(env: NodeJS.ProcessEnv = process.env): LearningService | null {
  setVocabularyScanner(null)
  const config = learningConfigFromEnv(env)
  if (!config.enabled) {
    log.info("learning disabled", {reason: "LINKLINGO_LEARNING_ENABLED is not true"})
    return null
  }
  const problem = configProblem(config)
  const bucket = (env.LINKLINGO_OUTBOX_BUCKET || env.LINKLINGO_TAPE_BUCKET || "").trim()
  if (problem || !bucket) {
    log.error("learning enabled but not usable", {problem: problem ?? "no outbox bucket (LINKLINGO_OUTBOX_BUCKET)"})
    return null
  }
  const region = env.AWS_REGION || env.LINKLINGO_TAPE_REGION || "us-west-2"
  const store = new S3ObjectStore(bucket, region, {endpoint: env.LINKLINGO_S3_ENDPOINT?.trim() || undefined})
  setLearningService(new LearningService(store, config))
  service!.start()
  if (env.LINKLINGO_VOCABULARY_SCAN_ENABLED?.trim() !== "false") {
    const catchup = Number(env.LINKLINGO_VOCABULARY_CATCHUP_DAYS)
    setVocabularyScanner(
      new VocabularyScanner({
        store,
        delivery: service!,
        catchupDays: Number.isFinite(catchup) && catchup > 0 ? catchup : undefined,
      }),
    )
    vocabularyScanner!.start()
  }
  log.info("learning delivery started", {bucket, mandarin: config.mandarinUrl})
  return service
}

export function stopLearning(): void {
  setVocabularyScanner(null)
  setLearningService(null)
}

/**
 * The learner's identity comes only from the verified token. The keyring that
 * signed it namespaces the account, so a dev and a prod user never mix.
 */
export function identityOf(c: Context): SourceIdentity {
  const auth = c.get("mentraAuth") as {mentraUserId: string; claims?: {iss?: unknown}}
  const issuer = typeof auth.claims?.iss === "string" ? auth.claims.iss : "mentra"
  return {
    issuer,
    subject: auth.mentraUserId,
    environment: (c.get("mentraKeyring") as string | undefined) ?? "unverified",
  }
}

export interface PhoneStatus {
  state: string
  pending: number
  gaps: number
  lastError: string | null
  at: string
}

/** Best-effort phone-side state so the status screen can show a pending count the server cannot see. */
export const phoneStatuses = new Map<string, PhoneStatus>()
