#!/usr/bin/env bash
# Send a DM to a user who already interacted with the bot.
# Usage: dm.sh [--dry-run] <user_id> <text>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; shift; fi
if [[ $# -lt 2 ]]; then echo "Usage: $0 [--dry-run] <user_id> <text>" >&2; exit 2; fi
export TARGET_USER_ID="$1"; shift
export TARGET_TEXT="$*"
export DRY_RUN
exec node "$SRC/dm.js"
