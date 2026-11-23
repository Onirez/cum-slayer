#!/usr/bin/env bash
# Download a video (Discord CDN / Tenor / Giphy), extract 3–4 JPEG stills,
# and transcribe the first ~60 s of speech (local Whisper, French/English auto).
# Usage: vid.sh <url>
# Allowed hosts: cdn.discordapp.com, media.discordapp.net, *.tenor.com, *.giphy.com
# Max 25 MiB. The whole run is capped at ~28 s so the routine is never blocked
# longer than ~30 s. Cache files older than 24 h are deleted.
# Secrets/tokens in the URL are never printed. Transcription runs on the box only.
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
TIMEOUT="${VID_DOWNLOAD_TIMEOUT:-12}"
TOTAL_TIMEOUT="${VID_TOTAL_TIMEOUT:-28}"
MAX_AGE_MIN=1440
AUDIO_MAX_S="${VID_AUDIO_MAX_S:-60}"
START_S="$(date +%s)"

remaining() {
  local used=$(( $(date +%s) - START_S ))
  local left=$(( TOTAL_TIMEOUT - used ))
  if (( left < 0 )); then echo 0; else echo "$left"; fi
}

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

LOCAL=0
if [[ -n "${VID_ALLOW_LOCAL:-}" && -f "$URL" ]]; then
  LOCAL=1
fi

if [[ "$LOCAL" -eq 0 ]]; then
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
fi

if [[ "$LOCAL" -eq 1 ]]; then
  HASH="$(sha256sum -- "$URL" | awk '{print $1}')"
  EXT="$(python3 - "$URL" << 'PY'
import sys, os
name = os.path.basename(sys.argv[1]).lower()
for ext in (".mp4", ".m4v", ".mov", ".webm", ".qt"):
    if name.endswith(ext):
        print(".mp4" if ext in (".m4v",) else (".mov" if ext == ".qt" else ext))
        break
else:
    print(".mp4")
PY
)"
else
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
fi
VID="$CACHE/${HASH}${EXT}"
META="$CACHE/${HASH}.meta"
AUDIO_META="$CACHE/${HASH}.audio"

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
  if [[ -f "$AUDIO_META" ]]; then
    cat "$AUDIO_META"
  fi
}

transcribe_cached_video() {
  local left
  left="$(remaining)"
  if (( left < 3 )); then
    printf '%s\n' "audio=unavailable" "transcription indisponible (délai dépassé)" > "$AUDIO_META"
    chmod 600 "$AUDIO_META" 2>/dev/null || true
    return 0
  fi

  local has_audio=""
  has_audio="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "$VID" 2>/dev/null || true)"
  if [[ -z "$has_audio" ]]; then
    printf '%s\n' "audio=none" "pas de piste audio" > "$AUDIO_META"
    chmod 600 "$AUDIO_META"
    return 0
  fi

  local wav="$CACHE/${HASH}.wav"
  if ! ffmpeg -y -hide_banner -loglevel error -t "$AUDIO_MAX_S" -i "$VID" \
      -vn -ac 1 -ar 16000 -f wav "$wav" </dev/null
  then
    printf '%s\n' "audio=none" "pas de piste audio" > "$AUDIO_META"
    chmod 600 "$AUDIO_META"
    rm -f "$wav"
    return 0
  fi
  local wav_size
  wav_size="$(wc -c < "$wav" | tr -d ' ')"
  if [[ -z "$wav_size" || "$wav_size" -lt 1000 ]]; then
    printf '%s\n' "audio=none" "pas de piste audio" > "$AUDIO_META"
    chmod 600 "$AUDIO_META"
    rm -f "$wav"
    return 0
  fi

  left="$(remaining)"
  if (( left < 3 )); then
    printf '%s\n' "audio=unavailable" "transcription indisponible (délai dépassé)" > "$AUDIO_META"
    chmod 600 "$AUDIO_META"
    rm -f "$wav"
    return 0
  fi

  local out=""
  local status=0
  set +e
  AUD_SH="$_HERE/aud.sh"
  if [[ ! -x "$AUD_SH" ]]; then AUD_SH="$ROOT/aud.sh"; fi
  out="$(timeout --signal=TERM --kill-after=2s "${left}s" "$AUD_SH" "$wav" 2>/dev/null)"
  status=$?
  set -e
  rm -f "$wav"

  if [[ "$status" -eq 0 && -n "$out" ]]; then
    if grep -q '^transcript=' <<<"$out"; then
      printf 'audio=speech\n%s\n' "$out" > "$AUDIO_META"
    elif grep -q 'aucune parole détectée' <<<"$out"; then
      printf 'audio=no_speech\n%s\n' "$out" > "$AUDIO_META"
    elif grep -q 'pas de piste audio' <<<"$out"; then
      printf 'audio=none\n%s\n' "$out" > "$AUDIO_META"
    else
      printf 'audio=unavailable\n%s\n' "$out" > "$AUDIO_META"
    fi
  elif [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    printf '%s\n' "audio=unavailable" "transcription indisponible (délai dépassé)" > "$AUDIO_META"
  else
    printf '%s\n' "audio=unavailable" "transcription indisponible" > "$AUDIO_META"
  fi
  chmod 600 "$AUDIO_META"
}

ensure_audio() {
  if [[ -f "$AUDIO_META" ]]; then
    return 0
  fi
  if [[ ! -f "$VID" ]]; then
    return 0
  fi
  transcribe_cached_video
}

if [[ "$LOCAL" -eq 1 ]]; then
  # Copy the local file into the cache under the content hash (no URL).
  if [[ ! -f "$VID" ]]; then
    SIZE="$(wc -c < "$URL" | tr -d ' ')"
    if [[ -z "$SIZE" || "$SIZE" -eq 0 ]]; then
      echo "error: empty download" >&2
      exit 1
    fi
    if [[ "$SIZE" -gt "$MAX_BYTES" ]]; then
      echo "error: file exceeds 25 MB" >&2
      exit 1
    fi
    cp -f -- "$URL" "$VID"
    chmod 600 "$VID"
  fi
fi

if [[ -f "$VID" && -f "$META" ]] && compgen -G "$CACHE/${HASH}-*.jpg" >/dev/null; then
  ensure_audio
  print_result
  exit 0
fi

if [[ "$LOCAL" -eq 0 ]]; then
  TMP="$(mktemp "$CACHE/tmp.XXXXXX")"
  cleanup() { rm -f "$TMP"; }
  trap cleanup EXIT

  DL_TIMEOUT="$TIMEOUT"
  LEFT="$(remaining)"
  if (( LEFT < DL_TIMEOUT )); then DL_TIMEOUT="$LEFT"; fi
  if (( DL_TIMEOUT < 3 )); then
    echo "error: download failed" >&2
    exit 1
  fi

  # Download with redirect host checks. Never print the URL.
  if ! python3 - "$URL" "$TMP" "$MAX_BYTES" "$DL_TIMEOUT" << 'PY'
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
fi

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

ensure_audio
print_result
