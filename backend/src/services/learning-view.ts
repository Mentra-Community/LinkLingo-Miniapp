/**
 * The Learning screen, as server-driven blocks. States follow the product
 * spec: Not connected, Capture paused, Listening, Waiting to send, Connection
 * needs attention. "Listening" only means the phone's capture is on; it is not
 * evidence that anything reached the Mandarin app, so the screen also shows
 * the last time an event was accepted and how many are still waiting.
 */

import type {View, ViewBlock} from "../ui-blocks"
import {BLOCK_KIT_VERSION} from "../ui-blocks"
import type {LearningStatus} from "./learning-outbox"

export interface PhoneReport {
  state: string
  pending: number
  gaps: number
  lastError: string | null
  at: string
}

export type LearningState = "not_connected" | "paused" | "listening" | "waiting" | "attention" | "unavailable"

export interface LearningViewInput {
  status: LearningStatus
  phone: PhoneReport | null
  now?: number
}

export function learningState({status, phone}: LearningViewInput): LearningState {
  if (!status.enabled) return "unavailable"
  if (!status.connected) return "not_connected"
  if (status.lastError || phone?.state === "needs_attention") return "attention"
  if (!phone || phone.state === "paused" || phone.state === "not_connected") return "paused"
  if (phone.pending > 0 || status.pendingServerEvents > 0 || phone.state === "waiting_to_send") return "waiting"
  return "listening"
}

const TITLES: Record<LearningState, string> = {
  not_connected: "Not connected",
  paused: "Capture paused",
  listening: "Listening",
  waiting: "Waiting to send",
  attention: "Connection needs attention",
  unavailable: "Not available",
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "Never"
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (seconds < 60) return "Just now"
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86_400)} d ago`
}

export function buildLearningView(input: LearningViewInput): View {
  const {status, phone} = input
  const now = input.now ?? Date.now()
  const state = learningState(input)
  const blocks: ViewBlock[] = []

  const detail: ViewBlock[] = []
  switch (state) {
    case "unavailable":
      detail.push({
        type: "text",
        text: status.problem ?? "Learning capture is not available on this server.",
        tone: "hint",
      })
      break
    case "not_connected":
      detail.push({
        type: "text",
        text: "Saves your conversations so the Mandarin app can help you review and practice them. In the Mandarin app, open Settings, then Learning, create a pairing code, and paste it here.",
        tone: "hint",
      })
      break
    case "attention":
      detail.push({
        type: "text",
        text: status.lastError ?? phone?.lastError ?? "Delivery is failing. Check your connection or pair again.",
        tone: "error",
      })
      break
    case "paused":
      detail.push({
        type: "text",
        text: "Turn on saving below to start keeping conversations. Live captions work either way.",
        tone: "hint",
      })
      break
    case "waiting":
      detail.push({
        type: "text",
        text: "Conversations are saved on your phone and will send when the connection allows.",
        tone: "hint",
      })
      break
    case "listening":
      detail.push({
        type: "text",
        text: "Saving what you say for review. This shows capture is on, not that anything has arrived yet.",
        tone: "hint",
      })
      break
  }

  const statusSection: ViewBlock[] = [
    {type: "text", text: TITLES[state], tone: state === "attention" ? "error" : "body"},
    ...detail,
  ]
  if (status.connected) {
    statusSection.push({
      type: "tiles",
      items: [
        {value: phone?.pending ?? 0, label: "Waiting on phone"},
        {value: status.pendingServerEvents, label: "Waiting on server"},
        {value: ago(status.lastAcceptedAt, now), label: "Last received"},
      ],
    })
    if (status.label) {
      statusSection.push({
        type: "text",
        text: `Connected to ${status.label}${status.environment ? ` · ${status.environment}` : ""}`,
        tone: "hint",
      })
    }
    if (phone && phone.gaps > 0) {
      statusSection.push({
        type: "text",
        text: `${phone.gaps} stretch${phone.gaps === 1 ? "" : "es"} of speech could not be kept because the phone queue was full.`,
        tone: "error",
      })
    }
  }
  blocks.push({type: "section", title: "Learning capture", blocks: statusSection})

  if (state !== "unavailable") {
    const controls: ViewBlock[] = []
    if (status.connected) {
      controls.push({
        type: "toggle",
        key: "learningCapture",
        title: "Save conversations for learning",
        detail: "Final transcripts only, kept for 90 days. Turning this off lets pending items finish sending.",
      })
    }
    if (!status.connected || state === "attention") {
      controls.push({
        type: "input",
        id: "pairing-code",
        title: status.connected ? "Pair again" : "Pairing code",
        detail: "From the Mandarin app: Settings, Learning, Create pairing code.",
        placeholder: "mps_…",
        submitLabel: "Connect",
        action: "learning-pair",
      })
    }
    if (controls.length)
      blocks.push({type: "section", title: status.connected ? "Controls" : "Connect", blocks: controls})
  }

  return {kit: BLOCK_KIT_VERSION, title: "Learning", blocks}
}
