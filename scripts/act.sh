#!/usr/bin/env bash
# Combined fast action: reply, react, optional file attachments, then memory/skill writes.
# Usage: act.sh [--dry-run] [--file file.zip]... < json
#   JSON: {"channel_id","message_id" (null = standalone message in channel_id),
#          "interaction_id" (optional, /fiche deferred follow-up; token is held by the bridge),
#          "reply":"text"|null,"react":"emoji"|null,
#          "files":[{"path":"/abs/file.zip","name":"optional-name.zip"}] or [{"name","content_type","data"}] (base64),
#          "memory_append":[{"subject","author","text"}],
#          "skill_create":{"author","trigger","rule"}|null,
#          "author_id":"real trigger author id","actions":[{"type":...}]}  (see mod.js)
# --file may be repeated (max 4). Allowed types include zip/html/txt/md/json/js/css/py/csv/pdf/mp3/mp4 and images;
# 8 MiB per file, 20 MiB total (under Discord's 20 MiB default / 25 MiB request cap). Optional JSON name to rename.
# Local paths are inlined as base64 before a remote /act call so the remote host never needs box paths.
# Reads DISCORD_BOT_TOKEN from the environment only; never prints it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

DRY_RUN="${DRY_RUN:-0}"
FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --file=*)
      FILES+=("${1#--file=}")
      shift
      ;;
    --file|-f)
      if [[ $# -lt 2 ]]; then
        echo "error: --file needs a path" >&2
        exit 2
      fi
      FILES+=("$2")
      shift 2
      ;;
    *)
      echo "Usage: $0 [--dry-run] [--file file.zip]... < json" >&2
      exit 2
      ;;
  esac
done

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  _extra=()
  if [[ "$DRY_RUN" == "1" ]]; then
    _extra+=(--dry-run)
  fi
  _inline=(--inline)
  for _f in "${FILES[@]}"; do
    _inline+=(--file "$_f")
  done
  node "$SRC/attachments.js" "${_inline[@]}" | "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "${_extra[@]}"
  exit $?
fi

export DRY_RUN
_args=()
if [[ "$DRY_RUN" == "1" ]]; then
  _args+=(--dry-run)
fi
for _f in "${FILES[@]}"; do
  _args+=(--file "$_f")
done
exec node "$SRC/act.js" "${_args[@]}"
