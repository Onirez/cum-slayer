#!/usr/bin/env bash
# Download a Discord CDN image, resize to a max 1024px JPEG, print the cache path.
# Usage: img.sh [--all] [--max 1024] <url> [url...]
# Allowed hosts: cdn.discordapp.com, media.discordapp.net
# Max 10 MiB, 8 s timeout (overridable with IMG_TIMEOUT). Cache purged after 24 h
# (GC at most every 30 min, or immediately if IMG_CACHE_GC_MIN=0).
# Several URLs are fetched in parallel. Secrets/tokens in the URL are never printed.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$DIR/img_fetch.py" "$@"
