/**
 * Emits the phone's copy of the "words a learner could already know" lists.
 *
 * `knownRankFor` tops out at 15000, so a token beyond that rank is rare for
 * every learner and the phone does not need to know anything about it. Keeping
 * only the head of each frequency list is what makes an on-device prefilter
 * affordable: the phone can decide "nothing here is worth glossing" and skip
 * the round trip entirely, which for an advanced learner was most calls.
 *
 * Only the languages worth the bundle weight are emitted. `hasRareToken` falls
 * back to "call the backend" for anything not generated here, so adding a
 * language is a size decision, never a correctness one.
 *
 *   bun backend/scripts/build-known-words.ts
 */

import {mkdirSync} from "node:fs"
import {join} from "node:path"

/**
 * How much of each frequency list the phone needs, which differs by writing
 * system rather than by taste.
 *
 * English is whitespace-delimited, so tokenizing does not consult the list at
 * all and anything past `knownRankFor(100)` (15000) is uniformly "rare". The
 * head is enough.
 *
 * Chinese has no spaces: the phone segments by matching against this very
 * list, so a word missing from it decomposes into its characters. Truncating
 * to 15000 was tried and silently lost glosses — 深远 (rank 20675) became
 * 深 + 远, both common, and the utterance looked entirely known. Ranks past
 * 15000 are all equally rare; they are carried because segmentation has to
 * know the word exists. prefilter-parity.test.ts locks this down.
 */
const LANGUAGES: Array<{lang: string; limit: number}> = [
  {lang: "zh_cn", limit: Number.POSITIVE_INFINITY},
  {lang: "en", limit: 15_000},
]

const repoRoot = join(import.meta.dir, "../..")
const source = join(repoRoot, "backend/data/freq")
const target = join(repoRoot, "miniapp/src/generated")

mkdirSync(target, {recursive: true})

for (const {lang, limit} of LANGUAGES) {
  const all = (await Bun.file(join(source, `${lang}.json`)).json()) as string[]
  const words = Number.isFinite(limit) ? all.slice(0, limit) : all
  const path = join(target, `known-${lang}.json`)
  await Bun.write(path, JSON.stringify(words))
  const bytes = (await Bun.file(path).arrayBuffer()).byteLength
  console.log(`${lang}: ${words.length} of ${all.length} words, ${Math.round(bytes / 1024)} KB`)
}

console.log(`\nwrote to ${target}`)
