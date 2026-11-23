#!/usr/bin/env bash
# Combined fast action: reply, react, memory/skill writes, optional plan.
# Usage: act.sh [--dry-run] < json
# JSON may include interaction_id for /fiche (token is held by the bridge, never in the JSON).
# Reads DISCORD_BOT_TOKEN from the environment only; never prints it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi
if [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--dry-run] < json" >&2
  exit 2
fi
export DRY_RUN
exec node "$SRC/act.js"
