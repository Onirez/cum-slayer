#!/usr/bin/env bash
# File-based user memory.
# Usage:
#   memory.sh get <user_id>
#   memory.sh list
#   memory.sh append <subject_user_id> <author_user_id> <facts>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
exec node "$SRC/memory.js" "$@"
