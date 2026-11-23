#!/usr/bin/env bash
# Per-user memory (history + notes). See src/user.js and docs/memoire-par-user.md.
# Usage:
#   user.sh get <user_id> [n]
#   user.sh history <user_id> [n] [--channel <id>] [--search <text>]
#   user.sh note <user_id> <author_id> <text>
#   user.sh unnote <user_id> <note_id>
#   user.sh forget <user_id> [all|notes|history]
#   user.sh optout|optin <user_id>
#   user.sh list [n]
#   user.sh throwback <user_id> [--force] [--dry-run]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
exec node "$SRC/user.js" "$@"
