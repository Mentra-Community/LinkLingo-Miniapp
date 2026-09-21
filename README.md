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
                       • gpt-oss-120b on Cerebras (JSON, minimal thinking)
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
cp .env.example .env   # add OPENROUTER_API_KEY for live glossing
bun run dev:local      # backend :3240 + miniapp QR
```

Scan the QR with the Mentra App. Settings persist in `session.storage`.

```bash
bun run typecheck
bun test
bun run freq:build -- /path/to/FrequencyWords   # regenerate data/freq
```

## Choosing the live model

The gloss/upgrade path runs whatever `OPENROUTER_MODEL` names, pinned to
`OPENROUTER_PROVIDER`. The pin is load-bearing: unpinned, OpenRouter routes by
price and picks a slower reseller of the same weights.

```bash
bun run bench:models:doppler                      # sweep candidates, latency first
bun run bench:models:doppler -- --only cerebras   # one candidate
```

`backend/scripts/bench-gloss-models.ts` replays the real prompt, candidate
filter and acceptance gate, so its recall is comparable to `eval:gloss`.
Measured over 78 calls each (add the caller's network RTT to all rows):

| model | p50 | p95 | recall |
| --- | --- | --- | --- |
| `openai/gpt-oss-120b` @ cerebras | 328ms | 430ms | 92% |
| `openai/gpt-oss-120b` @ groq | 300ms | 491ms | 92% |
| `openai/gpt-oss-20b` @ groq | 379ms | 493ms | 92% |
| `google/gemini-3.5-flash-lite` | 755ms | 976ms | 86% |

Two constraints come from reasoning models and are already handled in
`openrouter.ts`: every object in the JSON schema carries
`additionalProperties: false` (Cerebras 400s without it), and `maxOutputTokens`
budgets headroom for thinking, which cannot be disabled on gpt-oss and is
billed against the same ceiling.

## Deploy

Porter v2 specs live in `porter.dev.yaml` / `porter.prod.yaml`. Secrets come from Doppler project `linklingo`.

Pushes to `main` that touch `backend/`, `miniapp/`, `vendor/`, or `docker/` deploy
the dev app via `.github/workflows/porter-linklingo-miniapp-dev.yml`.

## Permanent install with auto-update

The image bakes the built miniapp and serves it at `<origin>/miniapp`:

```
GET /miniapp/miniapp.json           manifest the phone probes on every launch
GET /miniapp/dist/background/…      live background + UI entries
GET /miniapp/bundle.zip             flat bundle cached for offline launches
```

Install once on a phone — **Mentra App → Settings → Developer settings → Mini
App Development → Load from URL** →
`https://linklingo-miniapp-dev.mentraglass.com/miniapp` — and the home tile
persists. Every launch re-reads the manifest, runs the current hosted code, and
refreshes the on-disk copy that keeps the tile working with the backend
unreachable. So a merge to `main` ships to installed phones with no rescan: they
run the new build the next time LinkLingo is opened.

`GET /healthz` reports the hosted `miniapp.version` and the backend origin baked
into it, which is the fastest way to confirm a deploy actually shipped.

Unhosted alternatives: `bun run dev` (laptop must stay up, hot reload) and
`bun run miniapp:release` (LAN QR, offline install, rescan per version).

## Reviewing model output

The backend keeps the last ~24h of every gloss and upgrade call — the
transcript window the model saw, the `word:rank` candidates it was offered, its
verbatim answer, what reached the glasses, and what the filter dropped and why.
Read it with:

```
bun run review:doppler                       # last 24h from the dev deployment
bun run review:doppler -- --since 6h --problems   # only calls where the model broke a rule
bun run review:doppler -- --save backend/data/review.jsonl   # archive locally
bun run review -- --file backend/data/review.jsonl --since 7d # review the archive
```

Each entry carries `prompt=<hash>` so output before and after a prompt edit can
be compared.

## Measuring latency

`bun run review:latency` breaks one gloss into the phases it actually spends
time in, grouped by client build, server build and model:

```
client 1.0.16/a1b2c3d x server e4f5g6h x openai/gpt-oss-120b   n=143
                      p50     p95
  trigger->render      610    1240   (n=141)
  queue                 18     730   (n=143)
  phone RTT            391     760   (n=141)
  server               238     390   (n=143)
  model                217     350   (n=140)
  render                 3       8   (n=138)
  queue reason:    none 120  cooldown 21  coalesced 2
  phone RTT/idle:  <30s n=105 322/480   >2m n=10 714/1020
```

`trigger->render` is the number to optimise: eligible-to-rendered, measured
from timestamps rather than by summing the parts. `queue` is the wait the
engine imposed before sending, and `queue reason` names the mechanism that
caused it. Every row carries `n`; a p95 over fewer than 30 calls is printed but
should not be acted on.

Timings are keyed to a **client-minted** request id sent as `X-Request-Id`. The
phone only learns its own round trip after the response lands, so those numbers
ride along with the *next* request and the backend back-fills them onto the
entry whose id matches. Attaching them to the request that carried them would
pair one gloss's queue wait with the previous gloss's round trip. The newest
call in each session therefore always shows a pending `trigger->render`.

`--by-session` splits by session so a cold first request is separable from a
warm tenth. `--baseline <file>` prints deltas against an archived window:

```
bun run review:archive                                   # append to backend/data/review.jsonl
bun run review:latency -- --baseline backend/data/review-baseline.jsonl
```

The transcript tape additionally carries **shadow interim** results: both
candidate rules for the planned interim trigger (300 ms stable, 6-char growth)
are evaluated on the phone without sending anything, so how much earlier they
*would* have glossed is known before that behaviour ships.

`buildId` on `/healthz` and `serverBuildId` on every entry exist so a
backend-only change is visible against an unchanged client version. The CI
workflow stamps the commit into `build-id.txt`; the committed copy says `dev`,
which means "fall back to the working tree's git SHA". The pod's copy is in memory and resets on redeploy; `--save`
appends new entries (deduplicated) to a JSONL file, so a daily run keeps a
durable history. `--problems` is the prompt-tuning view: `untranslated` means
the model answered in the wrong language, `echo` that it repeated the word,
`not_candidate` that it invented a word off the list.

Every final utterance the glasses hear is also kept on the same 24h tape,
including speech the phone skipped (wrong language, too short, cooldown).
Each line is annotated with the rare-word candidates the frequency filter
would have offered — that is the "should this have been glossed?" view.

```
bun run review:doppler -- --transcripts
bun run review:doppler -- --transcripts --save backend/data/transcripts.jsonl
```

### Comment box (real-time)

Under the live rows in the WebView there is a comment box. Type anything about
what you just saw — "why did it gloss 餐厅", "the last one was wrong", a general
question — and hit Send. The phone ships the last few translations, the rows
on the HUD and the last ~30 s of speech; the backend adds the last 10 minutes
of that user's transcript tape and gloss calls plus the live gloss prompt, and
`google/gemini-3.1-pro-preview` (`OPENROUTER_ANALYST_MODEL`; thinking level
`GEMINI_ANALYST_THINKING`, default `medium`, ~8–10 s) answers in plain text,
grounded in the tape. Every exchange is archived on the same 24h tape:

```
bun run review:doppler -- --feedback
bun run review:doppler -- --feedback --save backend/data/feedback.jsonl
```

The raw endpoints are `GET /api/review/entries` (model I/O),
`GET /api/review/transcripts` (heard speech) and `GET /api/review/feedback`
(comments + analyst answers), all behind
`Authorization: Bearer $LINKLINGO_REVIEW_TOKEN`. They only exist when that
token is set; it lives in Doppler `linklingo/dev`, which is why the
`:doppler` script needs no setup.
