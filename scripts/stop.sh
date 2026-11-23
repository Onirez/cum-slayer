#!/usr/bin/env bash
# Stop the Discord bridge supervisor, keeper, watchdog, and the node process.
# Only targets processes of THIS checkout (markers include the repo path).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PIDFILE="$ROOT/bridge.pid"
LOG="$ROOT/bridge.log"
STOPFILE="$ROOT/.stopping"

touch "$STOPFILE"

stop_pid() {
  local pid="$1"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.2
    done
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
}

KEEPER_PIDFILE="$ROOT/keeper.pid"
if [[ -f "$KEEPER_PIDFILE" ]]; then
  kpid="$(cat "$KEEPER_PIDFILE" 2>/dev/null || true)"
  [[ -n "$kpid" ]] && { echo "stopping keeper pid $kpid"; stop_pid "$kpid"; }
  rm -f "$KEEPER_PIDFILE"
fi
pkill -f "cum-slayer-keeper:$ROOT" 2>/dev/null || true

WD_PIDFILE="$ROOT/watchdog.pid"
if [[ -f "$WD_PIDFILE" ]]; then
  wpid="$(cat "$WD_PIDFILE" 2>/dev/null || true)"
  [[ -n "$wpid" ]] && { echo "stopping watchdog pid $wpid"; stop_pid "$wpid"; }
  rm -f "$WD_PIDFILE"
fi
pkill -f "cum-slayer-watchdog:$ROOT" 2>/dev/null || true

if [[ -f "$PIDFILE" ]]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${oldpid}" ]]; then
    echo "stopping supervisor pid $oldpid"
    stop_pid "$oldpid"
  fi
  rm -f "$PIDFILE"
fi

# Fallback: match our node process by script path, and the supervisor bash.
# Patterns include $ROOT so another checkout (or the live box copy) is not touched.
pkill -f "$ROOT/src/bridge.js" 2>/dev/null || true
pkill -f "cum-slayer-supervisor:$ROOT" 2>/dev/null || true
pkill -f "cum-slayer-keeper:$ROOT" 2>/dev/null || true
pkill -f "cum-slayer-watchdog:$ROOT" 2>/dev/null || true

echo "$(date -Iseconds) [supervisor] stopped" >> "$LOG"
echo "bridge stopped"
