/**
 * One-shot generator: FrequencyWords 50k lists → compact JSON arrays
 * (words in rank order) under backend/data/freq/<lang>.json
 *
 * Usage:
 *   bun backend/scripts/build-frequency-data.ts [path-to-FrequencyWords]
 * Default source: ../MentraLink/src/FrequencyWords
 */

import {mkdir, readdir, readFile, writeFile} from "fs/promises"
import {join} from "path"

const LANGS = ["ar", "de", "en", "es", "fr", "it", "ko", "nl", "pt", "ru", "tr", "zh_cn"] as const

const defaultSource = join(
  import.meta.dir,
  "../../../MentraLink/src/FrequencyWords/content/2018",
)
const sourceRoot = process.argv[2]
  ? join(process.argv[2], "content/2018")
  : defaultSource
const outDir = join(import.meta.dir, "../data/freq")

async function buildLang(lang: string): Promise<void> {
  const folder = lang
  const file = join(sourceRoot, folder, `${folder}_50k.txt`)
  const raw = await readFile(file, "utf8")
  const words: string[] = []
  for (const line of raw.split("\n")) {
    const word = line.trim().split(/\s+/)[0]
    if (word) words.push(word)
  }
  if (words.length === 0) {
    throw new Error(`empty frequency list: ${file}`)
  }
  const dest = join(outDir, `${lang}.json`)
  await writeFile(dest, JSON.stringify(words))
  console.log(`wrote ${dest} (${words.length} words)`)
}

await mkdir(outDir, {recursive: true})
const available = new Set(await readdir(sourceRoot).catch(() => [] as string[]))
for (const lang of LANGS) {
  if (!available.has(lang)) {
    console.warn(`skip ${lang}: folder missing under ${sourceRoot}`)
    continue
  }
  await buildLang(lang)
}
