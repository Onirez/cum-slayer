#!/usr/bin/env bash
# Read-only Discord server helpers.
# Usage: mod.sh <list_roles|list_channels|list_members|member_info|list_bans|audit_log|list_emojis> ['{json args}']
# Mutating actions only go through act.sh "actions" (plan + confirmation).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
exec node "$SRC/mod.js" "$@"
