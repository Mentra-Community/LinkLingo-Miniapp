/**
 * S3-backed tape. The bucket outlives the pod, so a Karpenter eviction no
 * longer throws away the day's transcripts and gloss calls.
 */

import {DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client} from "@aws-sdk/client-s3"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {feedbackLog, type FeedbackEntry} from "./feedback-log"
import {reviewLog, type ReviewEntry} from "./review-log"
import {
  flushTape,
  ObjectTape,
  setTapePersister,
  tapeEnabled,
  trackTapeWrite,
  type ObjectStore,
} from "./tape-store"
import {transcriptLog, type TranscriptEntry} from "./transcript-log"

const log = createLogger("tape")

class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client

  constructor(
    private readonly bucket: string,
    region: string,
  ) {
    this.client = new S3Client({region})
  }

  async put(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
      }),
    )
  }

  async get(key: string): Promise<string | null> {
    try {
      const out = await this.client.send(new GetObjectCommand({Bucket: this.bucket, Key: key}))
      return (await out.Body?.transformToString()) ?? null
    } catch (error) {
      const name = (error as {name?: string}).name
      if (name === "NoSuchKey" || name === "NotFound") return null
      throw error
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const out = await this.client.send(
        new ListObjectsV2Command({Bucket: this.bucket, Prefix: prefix, ContinuationToken: token}),
      )
      for (const item of out.Contents ?? []) {
        if (item.Key) keys.push(item.Key)
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined
    } while (token)
    return keys
  }

  async delete(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {Objects: batch.map((Key) => ({Key})), Quiet: true},
        }),
      )
    }
  }
}

let tape: ObjectTape | null = null
let bucketName: string | null = null

export function tapeBucket(): string | null {
  return bucketName
}

export function tapeIsEnabled(): boolean {
  return tapeEnabled()
}

function install(store: ObjectTape): void {
  tape = store
  setTapePersister((kind, entry) => {
    const task = store.put(kind, entry).then(
      () => {
        metrics.increment("tape_writes_total", {kind, outcome: "ok"})
      },
      (error) => {
        metrics.increment("tape_writes_total", {kind, outcome: "error"})
        log.warn("tape write failed", {kind, id: entry.id, error})
      },
    )
    trackTapeWrite(task)
  })
}

function hydrate(loaded: Awaited<ReturnType<ObjectTape["loadAll"]>>): void {
  transcriptLog.loadFrom(loaded.transcript as TranscriptEntry[])
  reviewLog.loadFrom(loaded.review as ReviewEntry[])
  feedbackLog.loadFrom(loaded.feedback as FeedbackEntry[])
}

/**
 * Open the bucket, replay the last 24h into the rings, and keep writing.
 * A credential or network failure is logged and the process still serves;
 * gloss must not depend on the archive.
 */
export async function startTapeStore(): Promise<void> {
  const bucket = process.env.LINKLINGO_TAPE_BUCKET?.trim()
  if (!bucket) {
    log.info("tape store disabled", {reason: "LINKLINGO_TAPE_BUCKET unset"})
    return
  }
  const region = process.env.AWS_REGION || process.env.LINKLINGO_TAPE_REGION || "us-west-2"
  bucketName = bucket
  const store = new ObjectTape(new S3ObjectStore(bucket, region))
  try {
    const loaded = await store.loadAll()
    const removed = await store.prune()
    install(store)
    hydrate(loaded)
    log.info("tape store ready", {
      bucket,
      region,
      transcripts: loaded.transcript.length,
      reviews: loaded.review.length,
      feedback: loaded.feedback.length,
      pruned: removed,
    })
  } catch (error) {
    bucketName = null
    setTapePersister(null)
    tape = null
    log.error("tape store unavailable; this pod will keep tapes in memory only", {bucket, error})
  }
}

/** Pick up rows the previous pod wrote after this one had already loaded. */
export async function refreshTape(): Promise<void> {
  if (!tape) return
  try {
    hydrate(await tape.loadAll())
    await tape.prune()
  } catch (error) {
    log.warn("tape refresh failed", {error})
  }
}

export async function stopTapeStore(): Promise<void> {
  await flushTape()
}
