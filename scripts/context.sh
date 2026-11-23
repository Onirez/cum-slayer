#!/usr/bin/env bash
# Fetch reply context (target message + previous messages).
# Usage: context.sh [--dry-run] <channel_id> <message_id> [limit]
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
if [[ $# -lt 2 ]]; then echo "Usage: $0 [--dry-run] <channel_id> <message_id> [limit]" >&2; exit 2; fi
export TARGET_CHANNEL_ID="$1"
export TARGET_MESSAGE_ID="$2"
export CONTEXT_LIMIT="${3:-10}"
export DRY_RUN
exec node "$SRC/context.js"
