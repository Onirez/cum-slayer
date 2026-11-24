#!/usr/bin/env bash
# Même usage que scripts/act.sh : remote-act.sh [--dry-run] [--file image.png]... < json
# Inline les images locales ( --file ou JSON files:[{path}] ) en base64
# avant POST /act, pour que Fly n'ait jamais besoin d'un chemin de la box.
# À pointer depuis la routine IA une fois le pont hébergé (Fly ou autre).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
if [[ -f "$ROOT/attachments.js" ]]; then
  ATTACHMENTS_JS="$ROOT/attachments.js"
elif [[ -f "$ROOT/src/attachments.js" ]]; then
  ATTACHMENTS_JS="$ROOT/src/attachments.js"
else
  echo "error: attachments.js not found (looked in $ROOT and $ROOT/src)" >&2
  exit 1
fi

DRY_RUN=0
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
      echo "Usage: $0 [--dry-run] [--file image.png]... < json" >&2
      exit 2
      ;;
  esac
done

_extra=()
if [[ "$DRY_RUN" == "1" ]]; then
  _extra+=(--dry-run)
fi
_inline=(--inline)
for _f in "${FILES[@]}"; do
  _inline+=(--file "$_f")
done
# Always inline, even without --file, so JSON files:[{path}] is rewritten
# to base64 before the body leaves the box.
node "$ATTACHMENTS_JS" "${_inline[@]}" | "$DIR/remote-tool.sh" act "${_extra[@]}"
exit $?
