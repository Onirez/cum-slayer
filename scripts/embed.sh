#!/usr/bin/env bash
# Send a rich embed to a channel or DM.
# Usage: embed.sh [--dry-run] (--channel-id ID | --user-id ID) [--title T] [--description D] [--color #RRGGBB] [--thumbnail URL] [--fields JSON]
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
CHANNEL_ID=""; USER_ID=""; TITLE=""; DESC=""; COLOR=""; THUMB=""; FIELDS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel-id) CHANNEL_ID="$2"; shift 2 ;;
    --user-id) USER_ID="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --description) DESC="$2"; shift 2 ;;
    --color) COLOR="$2"; shift 2 ;;
    --thumbnail) THUMB="$2"; shift 2 ;;
    --fields) FIELDS="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
export TARGET_CHANNEL_ID="$CHANNEL_ID"
export TARGET_USER_ID="$USER_ID"
export EMBED_TITLE="$TITLE"
export EMBED_DESCRIPTION="$DESC"
export EMBED_COLOR="$COLOR"
export EMBED_THUMBNAIL="$THUMB"
export EMBED_FIELDS="$FIELDS"
export DRY_RUN
exec node "$SRC/embed.js"
