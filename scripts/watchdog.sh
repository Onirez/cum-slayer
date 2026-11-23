#!/usr/bin/env bash
# External watchdog, independent of node. Started by start.sh, stopped by stop.sh.
# If data/heartbeat is stale, or the heartbeat/log show a dead gateway, kill
# the node process so the supervisor loop restarts it. Never logs any secret.
DIR="$1"; LOG="$2"; MARKER="$3"
: "$MARKER"
cd "$DIR" || exit 1
HB="$DIR/data/heartbeat"
STOPFILE="$DIR/.stopping"
INTERVAL="${WD_INTERVAL:-20}"
STALE="${WD_STALE:-75}"
GRACE="${WD_GRACE:-90}"
LOG_STALE="${WD_LOG_STALE:-90}"
GW_IDLE_MAX_MS="${WD_GW_IDLE_MAX_MS:-90000}"
gw_bad_strikes=0
log() { echo "$(date -Iseconds) [watchdog] $*" >> "$LOG"; }
log "started interval=${INTERVAL}s stale=${STALE}s grace=${GRACE}s log_stale=${LOG_STALE}s"
file_age() {
  local f="$1"
  if [[ -f "$f" ]]; then
    echo $(( $(date +%s) - $(stat -c %Y "$f") ))
  else
    echo 999999
  fi
}
supervisor_alive() { pgrep -f "cum-slayer-supervisor:$DIR" >/dev/null 2>&1; }
keeper_alive() { pgrep -f "cum-slayer-keeper:$DIR" >/dev/null 2>&1; }
ensure_supervisor() {
  [[ -f "$STOPFILE" ]] && return 0
  supervisor_alive && return 0
  log "supervisor missing"
  if [[ -n "${DISCORD_BOT_TOKEN:-}" && -x "$DIR/scripts/start.sh" ]]; then
    log "relaunching start.sh"
    bash "$DIR/scripts/start.sh" || log "start.sh failed"
  elif [[ -x "$DIR/scripts/keeper.sh" ]] && keeper_alive; then
    log "waiting for keeper to relaunch supervisor"
  else
    log "cannot relaunch supervisor from this process; waiting for keeper or a fresh start.sh"
  fi
}
kill_node() {
  local pid="$1" reason="$2"
  log "${reason}: killing node pid=$pid so the supervisor restarts it"
  kill -CONT "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "node pid=$pid ignored SIGTERM, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}
heartbeat_gateway_bad() {
  local content idle gw
  content="$(cat "$HB" 2>/dev/null || true)"
  [[ -z "$content" ]] && return 1
  gw="$(printf '%s' "$content" | sed -n 's/.* gw=\([^ ]*\).*/\1/p')"
  idle="$(printf '%s' "$content" | sed -n 's/.*idle_ms=\([0-9-]*\).*/\1/p')"
  if [[ "$gw" == "bad" || "$gw" == "silent" ]]; then
    return 0
  fi
  if [[ -n "$idle" && "$idle" =~ ^[0-9]+$ ]] && (( idle > GW_IDLE_MAX_MS )); then
    return 0
  fi
  return 1
}
log_shows_dead_gateway() {
  local last
  last="$(grep -E 'watchdog (unhealthy|clock jump|forcing restart)|forcing restart \(|no gateway ack/dispatch|\[supervisor\] starting node|ready logged in' "$LOG" 2>/dev/null | tail -n 8 || true)"
  [[ -z "$last" ]] && return 1
  if printf '%s\n' "$last" | tail -n 1 | grep -Eq 'watchdog (unhealthy|clock jump|forcing restart)|forcing restart \(|no gateway ack/dispatch'; then
    return 0
  fi
  return 1
}
while true; do
  sleep "$INTERVAL"
  [[ -f "$STOPFILE" ]] && continue
  ensure_supervisor
  pid="$(pgrep -f "node $DIR/src/bridge.js" | head -n1 || true)"
  if [[ -z "$pid" ]]; then
    gw_bad_strikes=0
    continue
  fi
  age_proc="$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')"
  [[ -z "$age_proc" ]] && continue
  hb_age="$(file_age "$HB")"
  log_age="$(file_age "$LOG")"
  reason=""
  if (( hb_age > STALE && age_proc > GRACE )); then
    reason="heartbeat stale (${hb_age}s, node pid=$pid up ${age_proc}s)"
  fi
  if [[ -z "$reason" ]] && (( age_proc > GRACE )) && heartbeat_gateway_bad; then
    gw_bad_strikes=$((gw_bad_strikes + 1))
    if (( gw_bad_strikes >= 2 )); then
      reason="heartbeat gateway state bad (idle/gw, node pid=$pid up ${age_proc}s)"
    fi
  else
    gw_bad_strikes=0
  fi
  if [[ -z "$reason" ]] && (( age_proc > GRACE && hb_age > STALE && log_age > LOG_STALE )); then
    reason="heartbeat and bridge.log stale (hb=${hb_age}s log=${log_age}s, node pid=$pid up ${age_proc}s)"
  fi
  if [[ -z "$reason" ]] && (( age_proc > GRACE && hb_age > STALE )) && log_shows_dead_gateway; then
    reason="bridge.log shows dead gateway and heartbeat is stale (node pid=$pid)"
  fi
  if [[ -n "$reason" ]]; then
    kill_node "$pid" "$reason"
    gw_bad_strikes=0
  fi
done
