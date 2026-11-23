#!/usr/bin/env bash
# Add a reaction to a message.
# Usage: react.sh [--dry-run] <channel_id> <message_id> <emoji>
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
if [[ $# -lt 3 ]]; then echo "Usage: $0 [--dry-run] <channel_id> <message_id> <emoji>" >&2; exit 2; fi
export TARGET_CHANNEL_ID="$1"
export TARGET_MESSAGE_ID="$2"
export TARGET_EMOJI="$3"
export DRY_RUN
exec node "$SRC/react.js"
