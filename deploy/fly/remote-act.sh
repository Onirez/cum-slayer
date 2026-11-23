#!/usr/bin/env bash
# Même usage que scripts/act.sh : remote-act.sh [--dry-run] < json
# À pointer depuis la routine IA une fois le pont hébergé (Fly ou autre).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/remote-tool.sh" act "$@"
