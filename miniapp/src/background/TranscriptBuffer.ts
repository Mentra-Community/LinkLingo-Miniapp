export interface BufferedUtterance {
  id: string
  text: string
  isFinal: boolean
  language?: string
  at: number
}

const MAX_UTTERANCES = 10
const MAX_AGE_MS = 30_000

export class TranscriptBuffer {
  private utterances: BufferedUtterance[] = []
  private nextId = 1

  push(text: string, isFinal: boolean, language?: string, at = Date.now()): BufferedUtterance {
    const trimmed = text.trim()
    const last = this.utterances[this.utterances.length - 1]
    if (last && !last.isFinal) {
      last.text = trimmed
      last.isFinal = isFinal
      last.language = language
      last.at = at
      this.prune(at)
      return last
    }
    const entry: BufferedUtterance = {
      id: `u${this.nextId++}`,
      text: trimmed,
      isFinal,
      language,
      at,
    }
    this.utterances.push(entry)
    this.prune(at)
    return entry
  }

  context(maxChars = 400): string {
    return this.utterances
      .map((u) => u.text)
      .join(" ")
      .trim()
      .slice(-maxChars)
  }

  clear(): void {
    this.utterances = []
  }

  list(): BufferedUtterance[] {
    return [...this.utterances]
  }

  private prune(now: number): void {
    this.utterances = this.utterances.filter((u) => now - u.at <= MAX_AGE_MS)
    if (this.utterances.length > MAX_UTTERANCES) {
      this.utterances = this.utterances.slice(-MAX_UTTERANCES)
    }
  }
}

export function stripIncompleteLastWord(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  if (/[.!?。！？；;：:]$/.test(trimmed)) return trimmed
  const words = trimmed.split(/\s+/)
  if (words.length <= 1) return trimmed
  return words.slice(0, -1).join(" ")
}

export function hasSentenceEnd(text: string): boolean {
  return /[.!?。！？]/.test(text)
}
