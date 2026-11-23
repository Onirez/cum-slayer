#!/usr/bin/env bash
# Re-run the read-only full-history count. The bot token stays in the
# environment and is never printed, logged, or written to the result file.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$HERE/full_count.js" ]]; then
  ROOT="$HERE"
  SCRIPT="$HERE/full_count.js"
elif [[ -f "$HERE/src/full_count.js" ]]; then
  ROOT="$HERE"
  SCRIPT="$HERE/src/full_count.js"
elif [[ -f "$HERE/../full_count.js" ]]; then
  ROOT="$(cd "$HERE/.." && pwd)"
  SCRIPT="$ROOT/full_count.js"
elif [[ -f "$HERE/../src/full_count.js" ]]; then
  ROOT="$(cd "$HERE/.." && pwd)"
  SCRIPT="$ROOT/src/full_count.js"
else
  echo "full_count.js not found" >&2
  exit 1
fi
if [[ -d /app/data ]]; then
  DATA="/app/data"
else
  DATA="${DATA_DIR:-$ROOT/data}"
fi
OUT="${FULL_COUNT_FILE:-$DATA/full_count.json}"
HEAP="${FULL_COUNT_HEAP:-48}"
mkdir -p "$(dirname "$OUT")"
exec node --max-old-space-size="$HEAP" "$SCRIPT" --out "$OUT" "$@"
