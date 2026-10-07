import {BLOCK_KIT_VERSION, type AppConfig} from "./blocks"
import {DEFAULT_TUNABLES} from "./serverContract"

/**
 * What the phone runs on before it has ever reached the server, and when the
 * cached copy is unreadable. The server's version (backend/src/services/
 * app-config.ts) replaces it on the first successful fetch.
 */
export const DEFAULT_CONFIG: AppConfig = {
  kit: BLOCK_KIT_VERSION,
  revision: "bundled",
  tunables: {...DEFAULT_TUNABLES},
  settings: [
    {
      type: "toggle",
      key: "reverseGloss",
      title: "Gloss my {output} too",
      detail: "When you fall back to {output} mid-sentence, show it in {input}",
      disabledWhen: {key: "mode", equals: "translation"},
    },
    {
      type: "select",
      key: "reverseKnownRank",
      title: "Skip the most common {output}",
      detail: "Words this frequent are never glossed back",
      options: [300, 500, 1000, 2000].map((rank) => ({value: rank, label: `Top ${rank.toLocaleString("en-US")}`})),
      visibleWhen: {key: "reverseGloss", equals: true},
    },
  ],
  screens: [{id: "reports", title: "Reports", period: true}],
  prefDefaults: {},
}
