# vendor/ — bundled `@mentra/*` workspace packages

These three packages are **not published to npm yet**, so they are vendored here
(as bun workspace members) to keep this repo installable without the MentraOS
monorepo:

| package               | used by            | source in MentraOS monorepo |
| --------------------- | ------------------ | --------------------------- |
| `@mentra/auth`        | backend (JWKS auth)| `cloud-v2/packages/auth`    |
| `@mentra/miniapp`     | miniapp client     | `mobile/modules/miniapp`    |
| `@mentra/miniapp-cli` | miniapp dev/build  | `sdk/miniapp-cli`           |

Refresh from a monorepo checkout:

```bash
bun run sync-vendor /Users/mentra/Documents/MentraApps/MentraOS
bun install
```
