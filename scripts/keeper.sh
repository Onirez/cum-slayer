#!/usr/bin/env bash
# Mutual self-heal for the supervisor and the external watchdog.
# Started by start.sh (inherits env, including the bot token). Never logs,
# echoes, or writes any secret. Stopped by stop.sh via the .stopping flag.
DIR="$1"; LOG="$2"; MARKER="$3"
: "$MARKER"
cd "$DIR" || exit 1
STOPFILE="$DIR/.stopping"
WD_MARKER="cum-slayer-watchdog:$DIR"
log() { echo "$(date -Iseconds) [keeper] $*" >> "$LOG"; }
log "started"
start_watchdog() {
  if pgrep -f "$WD_MARKER" >/dev/null 2>&1; then
    return 0
  fi
  log "watchdog missing, relaunching"
  setsid nohup env -u DISCORD_BOT_TOKEN -u ROUTINE_WEBHOOK_KEY -u ROUTINE_WEBHOOK_URL \
    -u GROK_WEBHOOK_KEY -u GROK_WEBHOOK_URL \
    bash "$DIR/scripts/watchdog.sh" "$DIR" "$LOG" "$WD_MARKER" >> "$DIR/supervisor.out" 2>&1 &
  echo "$!" > "$DIR/watchdog.pid"
}
start_supervisor() {
  if pgrep -f "cum-slayer-supervisor:$DIR" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "${DISCORD_BOT_TOKEN:-}" ]]; then
    log "supervisor missing, but this process has no token; cannot relaunch"
    return 1
  fi
  log "supervisor missing, relaunching start.sh"
  bash "$DIR/scripts/start.sh" || log "start.sh failed"
}
while true; do
  sleep 15
  if [[ -f "$STOPFILE" ]]; then
    continue
  fi
  start_supervisor
  start_watchdog
done
