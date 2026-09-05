import {useEffect, useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"

import type {Channels} from "../shared/channels"
import type {
  LinkLingoDiagnostics,
  LinkLingoMode,
  LinkLingoSettings,
  LinkLingoSnapshot,
} from "../shared/types"
import {DEFAULT_SETTINGS, inputLanguage, outputLanguage} from "../shared/types"
import {LANGUAGES, languageName, languageOptionLabel} from "./lib/languages"

const MODES: Array<{id: LinkLingoMode; label: string}> = [
  {id: "gloss", label: "Words"},
  {id: "gloss-captions", label: "Words + text"},
  {id: "translation", label: "Translate"},
]

export function App() {
  const isDark = useColorScheme() !== "light"
  const {insets} = useSafeArea()
  const [displayOpen, setDisplayOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState<LinkLingoDiagnostics | null>(null)
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
      mentra.on("link:diagnostics", setDiagnostics),
    ]
    mentra.send("link:request-snapshot", {})
    return () => unsubs.forEach((u) => u())
  }, [])

  const settings = snap.settings
  const heard = languageName(inputLanguage(settings))
  const gloss = languageName(outputLanguage(settings))
  const status = statusMeta(snap)

  const setSetting = <K extends keyof LinkLingoSettings>(
    key: K,
    channel: keyof Channels,
    payload: Channels[typeof channel],
    value: LinkLingoSettings[K],
  ) => {
    setSnap((s) => ({...s, settings: {...s.settings, [key]: value}}))
    mentra.send(channel as never, payload as never)
  }

  const swapPair = () => {
    const nextSource = settings.targetLanguage
    const nextTarget = settings.sourceLanguage
    setSnap((s) => ({
      ...s,
      settings: {...s.settings, sourceLanguage: nextSource, targetLanguage: nextTarget, swapDirection: false},
    }))
    mentra.send("link:set-source-language", {language: nextSource})
    mentra.send("link:set-target-language", {language: nextTarget})
    if (settings.swapDirection) {
      mentra.send("link:set-swap-direction", {swapDirection: false})
    }
  }

  return (
    <div
      className={`screen ${isDark ? "theme-dark" : "theme-light"}`}
      style={{paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right}}>
      <div className="wrap">
        <header className="topbar">
          <div className="brand">
            <span className="kicker">Glasses tutor</span>
            <h1>LinkLingo</h1>
            <p className="lede">
              Hear {heard}. See {gloss}.
            </p>
          </div>
          <div className={`status-pill ${status.tone}`}>
            <span className="status-dot" />
            {status.label}
          </div>
        </header>

        <div className="stack">
          <section className="card live-card">
            <div className="card-head">
              <h2 className="card-title">Live</h2>
              <span className="meta">
                {snap.processing ? "Glossing…" : latency(snap)}
              </span>
            </div>
            {snap.words.length > 0 ? (
              <div className="words">
                {snap.words.map((word) => (
                  <div key={`${word.word}-${word.at}`} className={`word-chip${word.isUpgrade ? " upgrade" : ""}`}>
                    <b>{word.word}</b>
                    <small>{word.translation}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-live">
                <strong>Listening for {heard}</strong>
                <span>Rare words and upgrades will stack here as people talk around you.</span>
              </div>
            )}
            {settings.mode !== "translation" && snap.caption ? <p className="caption">{snap.caption}</p> : null}
            {settings.mode === "translation" && (snap.translation || snap.original) ? (
              <>
                <p className="translation">{snap.translation}</p>
                <p className="original">{snap.original}</p>
              </>
            ) : null}
            {snap.backend.lastError ? <p className="hint">{snap.backend.lastError}</p> : null}
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Languages</h2>
            </div>
            <div className="pair">
              <div className="lang">
                <label htmlFor="source-language">Hearing</label>
                <select
                  id="source-language"
                  className="select"
                  value={settings.sourceLanguage}
                  onChange={(e) =>
                    setSetting("sourceLanguage", "link:set-source-language", {language: e.target.value}, e.target.value)
                  }>
                  {LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {languageOptionLabel(language.code)}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="swap" aria-label="Swap languages" onClick={swapPair}>
                ⇄
              </button>
              <div className="lang">
                <label htmlFor="target-language">Show in</label>
                <select
                  id="target-language"
                  className="select"
                  value={settings.targetLanguage}
                  onChange={(e) =>
                    setSetting("targetLanguage", "link:set-target-language", {language: e.target.value}, e.target.value)
                  }>
                  {LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {languageOptionLabel(language.code)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="hint">
              Gloss {heard} speech into {gloss}. Swap if you want the other way.
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Mode</h2>
            </div>
            <div className="seg" role="tablist" aria-label="Learning mode">
              {MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={settings.mode === mode.id}
                  className={settings.mode === mode.id ? "on" : ""}
                  onClick={() => setSetting("mode", "link:set-mode", {mode: mode.id}, mode.id)}>
                  {mode.label}
                </button>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Learning</h2>
              <span className="meta">{proficiencyLabel(settings.proficiency)}</span>
            </div>
            <input
              className="slider"
              type="range"
              min={0}
              max={100}
              value={settings.proficiency}
              aria-label="Proficiency"
              onChange={(e) =>
                setSetting("proficiency", "link:set-proficiency", {proficiency: Number(e.target.value)}, Number(e.target.value))
              }
            />
            <div className="level">
              <span>Beginner</span>
              <b>{settings.proficiency}</b>
              <span>Advanced</span>
            </div>
            <div className="rows">
              <ToggleRow
                title="Word upgrades"
                detail="Also show harder synonyms you should learn"
                checked={settings.wordUpgrades}
                disabled={settings.mode === "translation"}
                onChange={(wordUpgrades) =>
                  setSetting("wordUpgrades", "link:set-word-upgrades", {wordUpgrades}, wordUpgrades)
                }
              />
              <ToggleRow
                title="Pinyin"
                detail="Add pronunciation under Chinese"
                checked={settings.pinyinDisplay}
                onChange={(pinyinDisplay) =>
                  setSetting("pinyinDisplay", "link:set-pinyin-display", {pinyinDisplay}, pinyinDisplay)
                }
              />
            </div>
          </section>

          <section className="card">
            <button
              type="button"
              className="disclosure"
              aria-expanded={displayOpen}
              onClick={() => setDisplayOpen((open) => !open)}>
              <h2 className="card-title">Glasses display</h2>
              <span className={`chevron${displayOpen ? " open" : ""}`}>›</span>
            </button>
            {displayOpen ? (
              <div className="display-body">
                <label className="row-copy">
                  <strong>Caption lines · {settings.displayLines}</strong>
                  <input
                    className="slider"
                    type="range"
                    min={2}
                    max={5}
                    value={settings.displayLines}
                    onChange={(e) =>
                      setSetting(
                        "displayLines",
                        "link:set-display-lines",
                        {displayLines: Number(e.target.value)},
                        Number(e.target.value),
                      )
                    }
                  />
                </label>
                <label className="row">
                  <span className="row-copy">
                    <strong>Width</strong>
                    <span>How much HUD real estate to use</span>
                  </span>
                  <select
                    className="select"
                    style={{width: 132, minHeight: 44, fontSize: 14}}
                    value={settings.displayWidth}
                    onChange={(e) =>
                      setSetting(
                        "displayWidth",
                        "link:set-display-width",
                        {displayWidth: Number(e.target.value) as 0 | 1 | 2},
                        Number(e.target.value) as 0 | 1 | 2,
                      )
                    }>
                    <option value={0}>Narrow</option>
                    <option value={1}>Medium</option>
                    <option value={2}>Wide</option>
                  </select>
                </label>
                <ToggleRow
                  title="Break mid-word"
                  detail="Wrap long HUD lines more aggressively"
                  checked={settings.wordBreaking}
                  onChange={(wordBreaking) =>
                    setSetting("wordBreaking", "link:set-word-breaking", {wordBreaking}, wordBreaking)
                  }
                />
              </div>
            ) : null}
          </section>

          <section className="card">
            <button
              type="button"
              className="disclosure"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((open) => !open)}>
              <h2 className="card-title">Diagnostics</h2>
              <span className={`chevron${diagnosticsOpen ? " open" : ""}`}>›</span>
            </button>
            {diagnosticsOpen ? <DiagnosticsBody diagnostics={diagnostics} /> : null}
          </section>

          <div className="actions">
            <button type="button" className="danger" onClick={() => mentra.send("link:clear", {})}>
              Clear HUD
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onChange,
}: {
  title: string
  detail: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="row">
      <span className="row-copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        className={`switch${checked ? " on" : ""}`}
        onClick={() => onChange(!checked)}
      />
    </div>
  )
}

/**
 * Mirrors the background counters. A phone has no log tail, so this is the only
 * way to see engine throughput without plugging in a USB cable.
 */
function DiagnosticsBody({diagnostics}: {diagnostics: LinkLingoDiagnostics | null}) {
  if (!diagnostics) {
    return <p className="hint">Waiting for the background service to report…</p>
  }

  const counters = Object.entries(diagnostics.counters).sort(([a], [b]) => a.localeCompare(b))
  const timings = Object.entries(diagnostics.timings).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="display-body diag">
      <div className="diag-row">
        <span>Uptime</span>
        <b>{formatDuration(diagnostics.uptimeSeconds)}</b>
      </div>
      {diagnostics.lastError ? (
        <div className="diag-error">
          <strong>Last error</strong>
          <span>{diagnostics.lastError}</span>
          {diagnostics.lastErrorAt ? <em>{timeAgo(diagnostics.lastErrorAt)}</em> : null}
        </div>
      ) : (
        <div className="diag-row">
          <span>Errors</span>
          <b>None</b>
        </div>
      )}

      {timings.length > 0 ? (
        <>
          <p className="diag-head">Latency</p>
          {timings.map(([name, timing]) => (
            <div key={name} className="diag-row">
              <span>{name}</span>
              <b>
                {timing.lastMs}ms · avg {timing.avgMs} · max {timing.maxMs}
              </b>
            </div>
          ))}
        </>
      ) : null}

      {counters.length > 0 ? (
        <>
          <p className="diag-head">Counters</p>
          {counters.map(([name, value]) => (
            <div key={name} className="diag-row">
              <span>{name}</span>
              <b>{value}</b>
            </div>
          ))}
        </>
      ) : (
        <p className="hint">No activity recorded yet.</p>
      )}
    </div>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  return seconds < 60 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`
}

function proficiencyLabel(value: number): string {
  if (value < 34) return "Beginner"
  if (value < 67) return "Intermediate"
  return "Advanced"
}

function latency(snap: LinkLingoSnapshot): string {
  const parts = []
  if (snap.profiling?.clientRoundTripMs != null) parts.push(`${snap.profiling.clientRoundTripMs}ms`)
  if (snap.profiling?.geminiMs != null) parts.push(`model ${snap.profiling.geminiMs}ms`)
  return parts.join(" · ") || "Ready"
}

function statusMeta(snap: LinkLingoSnapshot): {label: string; tone: string} {
  if (snap.processing) return {label: "Glossing", tone: "busy"}
  if (snap.backend.status === "error") return {label: "Error", tone: "bad"}
  if (snap.backend.status === "ok") return {label: "Live", tone: "good"}
  if (snap.backend.status === "mock") return {label: "Demo", tone: "warn"}
  return {label: "Ready", tone: "idle"}
}
