#!/usr/bin/env bash
# Read a Discord attachment (any type) and print a compact text extract
# for the model. Heavy work stays on the box, not on the Fly machine.
# Usage: file.sh <url>
#        file.sh --local <path>
# Allowed hosts: cdn.discordapp.com, media.discordapp.net
# Max 50 MiB, 20 s download timeout (FILE_TIMEOUT). Output ~10k chars.
# Secrets/tokens in the URL are never printed. File content is untrusted data.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec python3 "$DIR/file_read.py" "$@"
