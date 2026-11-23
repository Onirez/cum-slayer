#!/usr/bin/env bash
# File-based skills.
# Usage:
#   skills.sh list
#   skills.sh open <skill_id>
#   skills.sh create <author_user_id> <trigger> -- <rule>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
exec node "$SRC/skills.js" "$@"
