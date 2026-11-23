#!/usr/bin/env bash
# Start the Discord bridge under a restart loop (survives process crashes).
#
# Required env: DISCORD_BOT_TOKEN
# Optional: ROUTINE_WEBHOOK_URL, ROUTINE_WEBHOOK_KEY (triggers are logged but
# not forwarded if they are missing).
# Launch from a shell that already has the secrets; never print them.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"
PIDFILE="$ROOT/bridge.pid"
LOG="$ROOT/bridge.log"
STOPFILE="$ROOT/.stopping"

if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
  echo "error: DISCORD_BOT_TOKEN is not set." >&2
  echo "Export it in the environment (see .env.example), then run this script." >&2
  exit 1
fi

if [[ ! -f "$ROOT/node_modules/discord.js/package.json" ]]; then
  echo "error: discord.js is not installed. Run: cd $ROOT && npm install" >&2
  exit 1
fi

rm -f "$STOPFILE"

WD_PIDFILE="$ROOT/watchdog.pid"
WD_MARKER="cum-slayer-watchdog:$ROOT"
start_watchdog() {
  if [[ -f "$WD_PIDFILE" ]]; then
    local wpid; wpid="$(cat "$WD_PIDFILE" 2>/dev/null || true)"
    if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
      echo "watchdog already running (pid $wpid)"; return 0
    fi
    rm -f "$WD_PIDFILE"
  fi
  if pgrep -f "$WD_MARKER" >/dev/null 2>&1; then
    echo "watchdog already running (found by marker)"; return 0
  fi
  # The watchdog needs no secrets: strip them from its environment.
  setsid nohup env -u DISCORD_BOT_TOKEN -u ROUTINE_WEBHOOK_KEY -u ROUTINE_WEBHOOK_URL \
    -u GROK_WEBHOOK_KEY -u GROK_WEBHOOK_URL \
    bash "$ROOT/scripts/watchdog.sh" "$ROOT" "$LOG" "$WD_MARKER" >> "$ROOT/supervisor.out" 2>&1 &
  echo "$!" > "$WD_PIDFILE"
  echo "started watchdog pid $!"
}

KEEPER_PIDFILE="$ROOT/keeper.pid"
KEEPER_MARKER="cum-slayer-keeper:$ROOT"
start_keeper() {
  if [[ -f "$KEEPER_PIDFILE" ]]; then
    local kpid; kpid="$(cat "$KEEPER_PIDFILE" 2>/dev/null || true)"
    if [[ -n "$kpid" ]] && kill -0 "$kpid" 2>/dev/null; then
      echo "keeper already running (pid $kpid)"; return 0
    fi
    rm -f "$KEEPER_PIDFILE"
  fi
  if pgrep -f "$KEEPER_MARKER" >/dev/null 2>&1; then
    echo "keeper already running (found by marker)"; return 0
  fi
  # Keeper inherits the token so it can relaunch start.sh; it never logs env.
  setsid nohup bash "$ROOT/scripts/keeper.sh" "$ROOT" "$LOG" "$KEEPER_MARKER" >> "$ROOT/supervisor.out" 2>&1 &
  echo "$!" > "$KEEPER_PIDFILE"
  echo "started keeper pid $!"
}

if [[ -f "$PIDFILE" ]]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${oldpid}" ]] && kill -0 "$oldpid" 2>/dev/null; then
    echo "bridge already running (supervisor pid $oldpid)"
    start_watchdog
    start_keeper
    exit 0
  fi
  rm -f "$PIDFILE"
fi

MARKER="cum-slayer-supervisor:$ROOT"

{
  echo "$(date -Iseconds) [supervisor] launching restart loop (marker=$MARKER)"
} >> "$LOG"

setsid nohup bash -c '
  ROOT="$1"
  LOG="$2"
  MARKER="$3"
  cd "$ROOT"
  : "$MARKER"
  (
    while true; do
      sleep 15
      if [[ -f "$ROOT/.stopping" ]]; then
        continue
      fi
      if ! pgrep -f "cum-slayer-watchdog:$ROOT" >/dev/null 2>&1; then
        echo "$(date -Iseconds) [supervisor] watchdog missing, relaunching" >> "$LOG"
        setsid nohup env -u DISCORD_BOT_TOKEN -u ROUTINE_WEBHOOK_KEY -u ROUTINE_WEBHOOK_URL \
          -u GROK_WEBHOOK_KEY -u GROK_WEBHOOK_URL \
          bash "$ROOT/scripts/watchdog.sh" "$ROOT" "$LOG" "cum-slayer-watchdog:$ROOT" >> "$ROOT/supervisor.out" 2>&1 &
        echo $! > "$ROOT/watchdog.pid"
      fi
      if ! pgrep -f "cum-slayer-keeper:$ROOT" >/dev/null 2>&1; then
        echo "$(date -Iseconds) [supervisor] keeper missing, relaunching" >> "$LOG"
        setsid nohup bash "$ROOT/scripts/keeper.sh" "$ROOT" "$LOG" "cum-slayer-keeper:$ROOT" >> "$ROOT/supervisor.out" 2>&1 &
        echo $! > "$ROOT/keeper.pid"
      fi
    done
  ) &
  while true; do
    echo "$(date -Iseconds) [supervisor] starting node src/bridge.js" >> "$LOG"
    node "$ROOT/src/bridge.js" >> "$LOG" 2>&1
    code=$?
    echo "$(date -Iseconds) [supervisor] src/bridge.js exited with $code, restarting in 3s" >> "$LOG"
    sleep 3
  done
' _ "$ROOT" "$LOG" "$MARKER" >> "$ROOT/supervisor.out" 2>&1 &

sup_pid=$!
echo "$sup_pid" > "$PIDFILE"
sleep 0.2
echo "started supervisor pid $sup_pid (logs: $LOG)"
start_watchdog
start_keeper
