export interface SaveForLaterMatch {
  text: string
  usedPrevious: boolean
  matchedBy: "wake_word" | "save_phrase"
}

const COMMAND =
  /^\s*(?:(?:hey|okay|ok)\s+)?(?:(link\s*lingo|linklingo|lingo)\s*[,.:;!?-]*\s*)?(?:please\s+)?(?:(?:can|could|would)\s+you\s+|(?:i\s+(?:want|need)\s+you\s+to)\s+|(?:make\s+sure\s+(?:you\s+)?)\s*)?(save|remember|keep|note(?:\s+down)?|write\s+down)\b([\s\S]*)$/i

const EXPLICIT_MARKER = /\b(?:this|that|sentence|phrase|thought|for\s+later|to\s+review)\b/i

/**
 * Finds a deliberately broad save request in a final ASR segment.
 *
 * A Link Lingo/Lingo wake word is enough to make save/remember/keep/note an
 * intent. Without the wake word, the phrase must still contain a marker such
 * as "this sentence" or "for later". This accepts natural variants while
 * avoiding ordinary past-tense uses such as "I saved that yesterday".
 */
export function extractSaveForLater(text: string, previousText = ""): SaveForLaterMatch | null {
  const match = COMMAND.exec(text.trim())
  if (!match) return null
  const wakeWord = Boolean(match[1])
  const tail = match[3] ?? ""
  if (!wakeWord && !EXPLICIT_MARKER.test(tail)) return null

  const inline = stripCommandTail(tail)
  if (inline) {
    return {text: inline, usedPrevious: false, matchedBy: wakeWord ? "wake_word" : "save_phrase"}
  }

  const previous = cleanSentence(previousText)
  if (!previous || COMMAND.test(previous)) return null
  return {text: previous, usedPrevious: true, matchedBy: wakeWord ? "wake_word" : "save_phrase"}
}

function stripCommandTail(value: string): string {
  let text = value.trim()
  text = text.replace(
    /^(?:(?:this|that)(?:\s+(?:sentence|phrase|thought|one))?|(?:the\s+)?(?:sentence|phrase|thought|one))\b/i,
    "",
  )
  text = text.replace(/^\s*(?:for\s+later|to\s+review)\b/i, "")
  text = text.replace(/^\s*(?:that\s+says?|saying)\b/i, "")
  text = text.replace(/^[\s,.:;!?'"“”‘’\-–—]+/, "")
  return cleanSentence(text)
}

function cleanSentence(value: string): string {
  let text = value.trim()
  const quoted = /^(["“‘'])([\s\S]+)(["”’'])$/.exec(text)
  if (quoted) text = quoted[2]!.trim()
  return text
}
