#!/usr/bin/env bash
#
# Refresh the vendored @mentra/* packages from a local MentraOS monorepo
# checkout. These three packages are not on npm yet, so they ship in vendor/
# (prebuilt) to keep this repo self-contained.
#
# Usage:
#   bun run sync-vendor
#   bun run sync-vendor /path/to/MentraOS
set -euo pipefail

MONO="${1:-${MENTRAOS_DIR:-$HOME/Documents/MentraApps/MentraOS}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$MONO" ]; then
  echo "!! MentraOS monorepo not found at: $MONO" >&2
  echo "   Pass the path: bun run sync-vendor /path/to/MentraOS" >&2
  exit 1
fi

sync() {
  local from="$1" name="$2"
  local src="$MONO/$from"
  if [ ! -d "$src" ]; then
    echo "!! missing source: $src" >&2
    exit 1
  fi
  echo "→ vendor/$name   ($from)"
  rm -rf "$ROOT/vendor/$name"
  rsync -a \
    --exclude node_modules --exclude .git --exclude tsconfig.tsbuildinfo \
    "$src/" "$ROOT/vendor/$name/"
  python3 - "$ROOT/vendor/$name/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
sc = d.get("scripts", {})
for k in ("prepare", "prepublishOnly"):
    sc.pop(k, None)
d["scripts"] = sc
json.dump(d, open(p, "w"), indent=2)
open(p, "a").write("\n")
PY
}

sync "cloud-v2/packages/auth" "auth"
sync "mobile/modules/miniapp" "miniapp"
sync "sdk/miniapp-cli"        "miniapp-cli"

echo
echo "✓ vendored. Next:  bun install  &&  git add vendor bun.lock"
