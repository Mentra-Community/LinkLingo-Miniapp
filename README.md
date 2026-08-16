# LinkLingo

Learn languages on smart glasses. LinkLingo glosses rare words from live speech, shows captions, and can overlay a live translation — all on-device in MentraOS.

This is the **local-miniapp** rewrite of the legacy cloud SDK app ([`MentraLabs/MentraLink`](https://github.com/MentraLabs/MentraLink)), which is left untouched.

## How it's wired

```
┌─────────────────────────── phone (the miniapp) ───────────────────────────┐
│  background/  (JSContext, always on)        ui/  (WebView settings)        │
│  • live transcription / translation         • languages, proficiency       │
│  • HUD via display.render()                 • mode + word upgrades         │
│  • in-memory transcript buffer              • live words + RTT profiling   │
│            └──────────── typed channel (RPC + broadcast) ────────────┘     │
└───────────────────────────────────┬────────────────────────────────────────┘
                                     │  authed POST /api/gloss, /api/upgrade
                                     ▼
                       backend/  (Hono on Porter)
                       • frequency pre-filter
                       • Gemini 3.5 Flash-Lite (JSON, thinking off)
```

There is **no server-side glasses session**. Captions render locally with zero LLM. Gloss/upgrade is one hop to the backend (no cloud transcript-history fetch).

## Modes

- **Rare Word Glossing** — up to 3 glossed word rows
- **Glossing + Live Captions** — 2 word rows + 2 caption lines
- **Live Translation + Live Captions** — translation on top, original below
- **Word Upgrades** — optional toggle; suggests a useful new word every 5s

## Repo layout

```
miniapp/          on-phone miniapp (shipped as a zip)
  src/background/   JSContext brain
  src/ui/           React settings + live view
  src/shared/       channel + type contract
backend/          gloss/upgrade service (Hono on Bun)
  data/freq/        compact FrequencyWords 50k maps
vendor/           prebuilt unpublished @mentra packages
```

## Getting started

Prereqs: [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env   # add GEMINI_API_KEY for live glossing
bun run dev:local      # backend :3240 + miniapp QR
```

Scan the QR with the Mentra App. Settings persist in `session.storage`.

```bash
bun run typecheck
bun test
bun run freq:build -- /path/to/FrequencyWords   # regenerate data/freq
```

## Deploy

Porter v2 specs live in `porter.dev.yaml` / `porter.prod.yaml`. Secrets come from Doppler project `linklingo`.
