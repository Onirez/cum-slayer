#!/usr/bin/env bash
# Download a Discord CDN image into a local cache and print the path.
# Usage: img.sh <url>
# Allowed hosts: cdn.discordapp.com, media.discordapp.net
# Max 10 MiB, 15 s timeout. Cache files older than 24 h are deleted.
# Secrets/tokens in the URL are never printed.
set -euo pipefail

_HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$_HERE/data" ]]; then
  ROOT="$_HERE"
elif [[ -d "$_HERE/../data" ]]; then
  ROOT="$(cd "$_HERE/.." && pwd)"
else
  ROOT="$_HERE"
fi
CACHE="${IMG_CACHE_DIR:-$ROOT/data/img-cache}"
MAX_BYTES=$((10 * 1024 * 1024))
TIMEOUT=15
MAX_AGE_MIN=1440

URL="${1:-}"
if [[ $# -ne 1 || -z "$URL" ]]; then
  echo "Usage: $0 <url>" >&2
  exit 2
fi

mkdir -p "$CACHE"
# Evict stale cache files (older than 24 h). Stay inside $CACHE.
find "$CACHE" -type f -mmin +"$MAX_AGE_MIN" -delete 2>/dev/null || true

# Validate the URL (https, allowlisted host, no userinfo). Do not print it.
if ! python3 - "$URL" << 'PY'
import sys
from urllib.parse import urlparse
url = sys.argv[1]
try:
    u = urlparse(url)
except Exception:
    sys.exit(1)
host = (u.hostname or "").lower()
allowed = {"cdn.discordapp.com", "media.discordapp.net"}
if u.scheme != "https" or host not in allowed:
    sys.exit(1)
if u.username or u.password:
    sys.exit(1)
if u.port not in (None, 443):
    sys.exit(1)
sys.exit(0)
PY
then
  echo "error: only https URLs on cdn.discordapp.com or media.discordapp.net are allowed" >&2
  exit 1
fi

# Hash the URL so signed query strings stay off the filesystem name, and
# so we can reuse a fresh cache entry.
HASH="$(printf '%s' "$URL" | sha256sum | awk '{print $1}')"
EXT="$(python3 - "$URL" << 'PY'
import sys
from urllib.parse import urlparse, unquote
path = unquote(urlparse(sys.argv[1]).path or "")
name = path.rsplit("/", 1)[-1].lower()
for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
    if name.endswith(ext):
        print(ext)
        break
else:
    print(".img")
PY
)"
DEST="$CACHE/${HASH}${EXT}"
if [[ -f "$DEST" ]]; then
  printf '%s\n' "$DEST"
  exit 0
fi

TMP="$(mktemp "$CACHE/tmp.XXXXXX")"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# No redirects: a 3xx to another host must not be followed.
# --max-filesize aborts if the body exceeds 10 MiB.
if ! curl -sS -f --proto '=https' --tlsv1.2 \
    --max-time "$TIMEOUT" --connect-timeout 10 \
    --max-filesize "$MAX_BYTES" \
    --noproxy '*' \
    -A 'cum-slayer-bridge/img' \
    --output "$TMP" \
    -- "$URL" >/dev/null
then
  echo "error: download failed" >&2
  exit 1
fi

SIZE="$(wc -c < "$TMP" | tr -d ' ')"
if [[ -z "$SIZE" || "$SIZE" -eq 0 ]]; then
  echo "error: empty download" >&2
  exit 1
fi
if [[ "$SIZE" -gt "$MAX_BYTES" ]]; then
  echo "error: file exceeds 10 MB" >&2
  exit 1
fi

# Reject non-image bodies (HTML error pages, etc.).
if ! python3 - "$TMP" << 'PY'
import sys
path = sys.argv[1]
with open(path, "rb") as f:
    head = f.read(32)
if head.startswith(b"\x89PNG\r\n\x1a\n"):
    sys.exit(0)
if head.startswith(b"\xff\xd8\xff"):
    sys.exit(0)
if head.startswith(b"GIF87a") or head.startswith(b"GIF89a"):
    sys.exit(0)
if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
    sys.exit(0)
sys.exit(1)
PY
then
  echo "error: downloaded file is not a recognized image (png, jpeg, webp, gif)" >&2
  exit 1
fi

chmod 600 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
printf '%s\n' "$DEST"
