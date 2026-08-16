import {useEffect, useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import type {LinkLingoMode, LinkLingoSettings, LinkLingoSnapshot} from "../shared/types"
import {DEFAULT_SETTINGS} from "../shared/types"
import {LANGUAGES, languageName} from "./lib/languages"

const MODES: Array<{id: LinkLingoMode; label: string}> = [
  {id: "gloss", label: "Rare word glossing"},
  {id: "gloss-captions", label: "Glossing + captions"},
  {id: "translation", label: "Live translation + captions"},
]

export function App() {
  const isDark = useColorScheme() === "dark"
  const {insets} = useSafeArea()
  const [snap, setSnap] = useState<LinkLingoSnapshot>({
    settings: DEFAULT_SETTINGS,
    words: [],
    caption: "",
    translation: "",
    original: "",
    processing: false,
    backend: {status: "idle"},
    profiling: null,
  })

  useEffect(() => {
    const unsubs = [
      mentra.on("link:snapshot", setSnap),
      mentra.on("link:settings-update", (settings) => setSnap((s) => ({...s, settings}))),
      mentra.on("link:words", (words) => setSnap((s) => ({...s, words}))),
      mentra.on("link:caption", ({text}) => setSnap((s) => ({...s, caption: text}))),
      mentra.on("link:translation", ({original, translated}) =>
        setSnap((s) => ({...s, original, translation: translated})),
      ),
      mentra.on("link:processing", ({processing}) => setSnap((s) => ({...s, processing}))),
      mentra.on("link:backend-status", (backend) => setSnap((s) => ({...s, backend}))),
      mentra.on("link:profiling", (profiling) => setSnap((s) => ({...s, profiling}))),
    ]
    mentra.send("link:request-snapshot", {})
    return () => unsubs.forEach((u) => u())
  }, [])

  const settings = snap.settings
  const patch = <K extends keyof LinkLingoSettings>(key: K, channel: keyof import("../shared/channels").Channels, value: LinkLingoSettings[K]) => {
    setSnap((s) => ({...s, settings: {...s.settings, [key]: value}}))
    mentra.send(channel as never, {[key]: value} as never)
  }

  return (
    <div
      className={`min-h-screen ${isDark ? "bg-zinc-950 text-zinc-100" : "bg-zinc-100 text-zinc-900"}`}
      style={{paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right}}>
      <div className="max-w-lg mx-auto p-4 space-y-5">
        <header>
          <h1 className="text-2xl font-semibold">LinkLingo</h1>
          <p className="text-sm opacity-70">Learn from live speech on your glasses.</p>
        </header>

        <section className="rounded-2xl p-4 space-y-2 bg-white/80 dark:bg-zinc-900">
          <h2 className="text-sm font-medium opacity-70">Live</h2>
          {snap.words.length > 0 ? (
            <ul className="space-y-1">
              {snap.words.map((w) => (
                <li key={`${w.word}-${w.at}`} className="text-lg">
                  {w.isUpgrade ? "^ " : ""}
                  <span className="font-medium">{w.word}</span>
                  <span className="opacity-50"> → </span>
                  {w.translation}
                </li>
              ))}
            </ul>
          ) : (
            <p className="opacity-50">No glossed words yet.</p>
          )}
          {settings.mode !== "translation" && snap.caption ? (
            <p className="text-sm opacity-80">{snap.caption}</p>
          ) : null}
          {settings.mode === "translation" ? (
            <div className="text-sm space-y-1">
              <p>{snap.translation}</p>
              <p className="opacity-60">{snap.original}</p>
            </div>
          ) : null}
          <p className="text-xs opacity-50">
            {snap.processing ? "Glossing…" : snap.backend.status}
            {snap.profiling?.clientRoundTripMs != null ? ` · ${snap.profiling.clientRoundTripMs}ms` : ""}
            {snap.profiling?.geminiMs != null ? ` · model ${snap.profiling.geminiMs}ms` : ""}
          </p>
        </section>

        <section className="rounded-2xl p-4 space-y-3 bg-white/80 dark:bg-zinc-900">
          <h2 className="text-sm font-medium opacity-70">Languages</h2>
          <label className="block text-sm">
            Source
            <select
              className="mt-1 w-full rounded-lg p-2 bg-zinc-100 dark:bg-zinc-800"
              value={settings.sourceLanguage}
              onChange={(e) => patch("sourceLanguage", "link:set-source-language", e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Target
            <select
              className="mt-1 w-full rounded-lg p-2 bg-zinc-100 dark:bg-zinc-800"
              value={settings.targetLanguage}
              onChange={(e) => patch("targetLanguage", "link:set-target-language", e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.swapDirection}
              onChange={(e) => patch("swapDirection", "link:set-swap-direction", e.target.checked)}
            />
            Transcribe the target language (swap direction)
          </label>
          <p className="text-xs opacity-50">
            Listening: {languageName(settings.swapDirection ? settings.targetLanguage : settings.sourceLanguage)}
          </p>
        </section>

        <section className="rounded-2xl p-4 space-y-3 bg-white/80 dark:bg-zinc-900">
          <h2 className="text-sm font-medium opacity-70">Learning</h2>
          <label className="block text-sm">
            Proficiency {settings.proficiency}
            <input
              type="range"
              min={0}
              max={100}
              value={settings.proficiency}
              className="w-full"
              onChange={(e) => patch("proficiency", "link:set-proficiency", Number(e.target.value))}
            />
          </label>
          <div className="space-y-2">
            {MODES.map((mode) => (
              <label key={mode.id} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="mode"
                  checked={settings.mode === mode.id}
                  onChange={() => patch("mode", "link:set-mode", mode.id)}
                />
                {mode.label}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.wordUpgrades}
              disabled={settings.mode === "translation"}
              onChange={(e) => patch("wordUpgrades", "link:set-word-upgrades", e.target.checked)}
            />
            Word upgrades
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.pinyinDisplay}
              onChange={(e) => patch("pinyinDisplay", "link:set-pinyin-display", e.target.checked)}
            />
            Show pinyin for Chinese
          </label>
        </section>

        <section className="rounded-2xl p-4 space-y-3 bg-white/80 dark:bg-zinc-900">
          <h2 className="text-sm font-medium opacity-70">Display</h2>
          <label className="block text-sm">
            Caption lines {settings.displayLines}
            <input
              type="range"
              min={2}
              max={5}
              value={settings.displayLines}
              className="w-full"
              onChange={(e) => patch("displayLines", "link:set-display-lines", Number(e.target.value))}
            />
          </label>
          <label className="block text-sm">
            Width
            <select
              className="mt-1 w-full rounded-lg p-2 bg-zinc-100 dark:bg-zinc-800"
              value={settings.displayWidth}
              onChange={(e) =>
                patch("displayWidth", "link:set-display-width", Number(e.target.value) as 0 | 1 | 2)
              }>
              <option value={0}>Narrow</option>
              <option value={1}>Medium</option>
              <option value={2}>Wide</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.wordBreaking}
              onChange={(e) => patch("wordBreaking", "link:set-word-breaking", e.target.checked)}
            />
            Break mid-word
          </label>
        </section>

        <button
          type="button"
          className="w-full rounded-xl py-3 bg-teal-700 text-white"
          onClick={() => mentra.send("link:clear", {})}>
          Clear HUD
        </button>
      </div>
    </div>
  )
}
