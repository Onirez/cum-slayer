#!/usr/bin/env bash
# Download a video (Discord CDN / Tenor / Giphy) and extract 3–4 JPEG stills.
# Usage: vid.sh <url>
# Allowed hosts: cdn.discordapp.com, media.discordapp.net, *.tenor.com, *.giphy.com
# Max 25 MiB, 20 s timeout. Cache files older than 24 h are deleted.
# Secrets/tokens in the URL are never printed. No audio transcription.
set -euo pipefail

_HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "$_HERE/data" ]]; then
  ROOT="$_HERE"
elif [[ -d "$_HERE/../data" ]]; then
  ROOT="$(cd "$_HERE/.." && pwd)"
else
  ROOT="$_HERE"
fi
CACHE="${VID_CACHE_DIR:-$ROOT/data/vid-cache}"
MAX_BYTES=$((25 * 1024 * 1024))
TIMEOUT=20
MAX_AGE_MIN=1440

URL="${1:-}"
if [[ $# -ne 1 || -z "$URL" ]]; then
  echo "Usage: $0 <url>" >&2
  exit 2
fi

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "error: ffmpeg and ffprobe are required" >&2
  exit 1
fi

mkdir -p "$CACHE"
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
host = (u.hostname or "").lower().rstrip(".")
def allowed(h):
    if h in {"cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com"}:
        return True
    if h.endswith(".tenor.com") or h.endswith(".giphy.com"):
        return True
    return False
if u.scheme != "https" or not allowed(host):
    sys.exit(1)
if u.username or u.password:
    sys.exit(1)
if u.port not in (None, 443):
    sys.exit(1)
sys.exit(0)
PY
then
  echo "error: only https URLs on cdn.discordapp.com, media.discordapp.net, tenor.com or giphy.com are allowed" >&2
  exit 1
fi

HASH="$(printf '%s' "$URL" | sha256sum | awk '{print $1}')"
EXT="$(python3 - "$URL" << 'PY'
import sys
from urllib.parse import urlparse, unquote
path = unquote(urlparse(sys.argv[1]).path or "")
name = path.rsplit("/", 1)[-1].lower()
for ext in (".mp4", ".m4v", ".mov", ".webm", ".qt"):
    if name.endswith(ext):
        print(".mp4" if ext in (".m4v",) else (".mov" if ext == ".qt" else ext))
        break
else:
    print(".mp4")
PY
)"
VID="$CACHE/${HASH}${EXT}"
META="$CACHE/${HASH}.meta"
FRAME_GLOB="$CACHE/${HASH}-"

print_result() {
  if [[ ! -f "$META" ]]; then
    return 1
  fi
  cat "$META"
  local f
  shopt -s nullglob
  for f in "$CACHE/$HASH"-*.jpg; do
    printf '%s\n' "$f"
  done
  shopt -u nullglob
}

if [[ -f "$VID" && -f "$META" ]] && compgen -G "$CACHE/${HASH}-*.jpg" >/dev/null; then
  print_result
  exit 0
fi

TMP="$(mktemp "$CACHE/tmp.XXXXXX")"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

# Download with redirect host checks. Never print the URL.
if ! python3 - "$URL" "$TMP" "$MAX_BYTES" "$TIMEOUT" << 'PY'
import sys, ssl
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler

url, dest, max_bytes, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])

def allowed(h):
    if not h:
        return False
    h = h.lower().rstrip(".")
    if h in {"cdn.discordapp.com", "media.discordapp.net", "tenor.com", "giphy.com"}:
        return True
    return h.endswith(".tenor.com") or h.endswith(".giphy.com")

class GuardedRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urlparse(newurl)
        if u.scheme != "https" or not allowed(u.hostname) or u.username or u.password or (u.port not in (None, 443)):
            raise OSError("redirect to a host that is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)

ctx = ssl.create_default_context()
opener = build_opener(HTTPSHandler(context=ctx), GuardedRedirect())
req = Request(url, headers={"User-Agent": "cum-slayer-bridge/vid", "Accept": "video/*,*/*"})
try:
    with opener.open(req, timeout=timeout) as resp:
        final = urlparse(resp.geturl())
        if final.scheme != "https" or not allowed(final.hostname):
            raise OSError("final host is not allowed")
        length = resp.headers.get("Content-Length")
        if length is not None:
            try:
                if int(length) > max_bytes:
                    raise OSError("file exceeds 25 MB")
            except ValueError:
                pass
        got = 0
        with open(dest, "wb") as out:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                got += len(chunk)
                if got > max_bytes:
                    raise OSError("file exceeds 25 MB")
                out.write(chunk)
        if got == 0:
            raise OSError("empty download")
except Exception:
    sys.exit(1)
sys.exit(0)
PY
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
  echo "error: file exceeds 25 MB" >&2
  exit 1
fi

# Reject non-video bodies (HTML error pages, etc.).
if ! python3 - "$TMP" << 'PY'
import sys
path = sys.argv[1]
with open(path, "rb") as f:
    head = f.read(32)
# ISO BMFF / MP4 / MOV / M4V
if len(head) >= 8 and head[4:8] == b"ftyp":
    sys.exit(0)
# EBML (WebM / Matroska)
if head.startswith(b"\x1a\x45\xdf\xa3"):
    sys.exit(0)
sys.exit(1)
PY
then
  echo "error: downloaded file is not a recognized video (mp4, mov, webm)" >&2
  exit 1
fi

chmod 600 "$TMP"
mv -f "$TMP" "$VID"
trap - EXIT

DURATION="$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VID" 2>/dev/null || true)"
DURATION="$(python3 - "$DURATION" << 'PY'
import sys
raw = (sys.argv[1] or "").strip()
try:
    d = float(raw)
except ValueError:
    d = 0.0
if d < 0 or d != d or d == float("inf"):
    d = 0.0
print(f"{d:.3f}".rstrip("0").rstrip(".") if d else "0")
PY
)"

# Pick 3–4 timestamps spread across the duration (avoid the exact start/end).
TIMES="$(python3 - "$DURATION" << 'PY'
import sys
try:
    d = float(sys.argv[1] or 0)
except ValueError:
    d = 0.0
if d <= 0:
    times = [0.0, 0.3, 0.6]
elif d < 1.2:
    times = [max(0.0, d * 0.15), d * 0.5, max(0.0, d * 0.85)]
else:
    # 4 points at 1/5, 2/5, 3/5, 4/5
    times = [d * i / 5.0 for i in (1, 2, 3, 4)]
for t in times:
    print(f"{max(0.0, t):.3f}")
PY
)"

idx=1
while IFS= read -r t; do
  [[ -z "$t" ]] && continue
  out="$CACHE/${HASH}-${idx}.jpg"
  if ! ffmpeg -y -hide_banner -loglevel error -an \
      -ss "$t" -i "$VID" -frames:v 1 -q:v 3 \
      -vf "scale='min(1280,iw)':-2" \
      "$out" </dev/null
  then
    # Retry without the scale filter (odd dimensions, exotic codecs).
    ffmpeg -y -hide_banner -loglevel error -an \
      -ss "$t" -i "$VID" -frames:v 1 -q:v 3 \
      "$out" </dev/null || true
  fi
  if [[ -s "$out" ]]; then
    chmod 600 "$out"
    idx=$((idx + 1))
  else
    rm -f "$out"
  fi
done <<< "$TIMES"

if ! compgen -G "$CACHE/${HASH}-*.jpg" >/dev/null; then
  echo "error: failed to extract stills from the video" >&2
  exit 1
fi

FRAME_COUNT="$(ls -1 "$CACHE/${HASH}-"*.jpg 2>/dev/null | wc -l | tr -d ' ')"
{
  printf 'duration_s=%s\n' "$DURATION"
  printf 'frames=%s\n' "$FRAME_COUNT"
} > "$META"
chmod 600 "$META"

print_result
