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
      type: "select",
      key: "reverseKnownRank",
      title: "Skip the most common {output}",
      detail: "Whole sentences in {output} skip words this frequent. English inside Chinese is still translated.",
      options: [300, 500, 1000, 2000].map((rank) => ({value: rank, label: `Top ${rank.toLocaleString("en-US")}`})),
      disabledWhen: {key: "mode", equals: "translation"},
    },
  ],
  screens: [{id: "reports", title: "Reports", period: true}],
  prefDefaults: {},
}
