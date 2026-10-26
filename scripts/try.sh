#!/usr/bin/env bash
# Dev loop (not shipped): rebuild, repack and reinstall the package into a scratch project. Usage: scripts/try.sh <project dir>
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
out=${TMPDIR:-/tmp}/revbound-pack
mkdir -p "$out" && rm -f "$out"/*.tgz
(cd "$repo" && npm run build >/dev/null && npm pack --silent --pack-destination "$out" >/dev/null 2>&1)
cd "$1" && npm install --no-audit --no-fund "$out"/revbound-*.tgz >/dev/null 2>&1 && npx revbound sync
