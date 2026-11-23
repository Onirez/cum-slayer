#!/usr/bin/env bash
# Déploiement Fly.io du pont Discord.
# Usage :
#   ./deploy/fly/deploy-fly.sh --prepare   # app + volume + secrets (pas de machine Discord)
#   ./deploy/fly/deploy-fly.sh --deploy    # deploy --ha=false
#   ./deploy/fly/deploy-fly.sh --seed      # (re)copie data/ vers le volume
#   ./deploy/fly/deploy-fly.sh --dry-run   # affiche la cible, sans rien changer
# Ne journalise jamais les valeurs des secrets. Pas de `set -x`.
set -euo pipefail
set +x
export PATH="${HOME}/.fly/bin:/usr/bin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="$ROOT/deploy/fly/fly.toml"
APP="${FLY_APP:-cum-slayer-bridge}"
ORG="${FLY_ORG:-personal}"
REGION="${FLY_REGION:-cdg}"
VOLUME="${FLY_VOLUME:-bridge_data}"
SECRET_FILE="$ROOT/deploy/fly/.act_secret"
CMD="${1:-}"

fly() { command flyctl "$@"; }

destroy_builder() {
  # Les builders Fly laissent souvent un volume de 50 Go (0,15 $/Go/mois)
  # qui ferait à lui seul dépasser le plafond de 5 $. On les détruit après deploy.
  local builders
  builders="$(fly apps list --json 2>/dev/null | python3 -c '
import json,sys
raw=sys.stdin.read().strip()
if not raw:
    raise SystemExit(0)
data=json.loads(raw)
apps=data if isinstance(data,list) else data.get("apps") or data.get("data") or []
for a in apps:
    name=a.get("Name") or a.get("name") or ""
    if name.startswith("fly-builder-"):
        print(name)
')"
  if [[ -z "$builders" ]]; then
    log "No fly-builder app to destroy."
    return 0
  fi
  while IFS= read -r b; do
    [[ -z "$b" ]] && continue
    log "Destroying builder app $b (its volume would exceed the \$5 cap if left)."
    fly apps destroy "$b" -y
  done <<< "$builders"
}

die() { echo "error: $*" >&2; exit 1; }
log() { echo "$*"; }

need_login() {
  if ! fly auth whoami >/dev/null 2>&1; then
    die "flyctl n'est pas connecté. Lance : flyctl auth login"
  fi
}

webhook_url() { printf '%s' "${ROUTINE_WEBHOOK_URL:-${GROK_WEBHOOK_URL:-}}"; }
webhook_key() { printf '%s' "${ROUTINE_WEBHOOK_KEY:-${GROK_WEBHOOK_KEY:-}}"; }

ensure_secrets_in_env() {
  [[ -n "${DISCORD_BOT_TOKEN:-}" ]] || die "DISCORD_BOT_TOKEN is not set"
  [[ -n "$(webhook_key)" ]] || die "ROUTINE_WEBHOOK_KEY is not set"
  [[ -n "$(webhook_url)" ]] || die "ROUTINE_WEBHOOK_URL is not set"
  if [[ -z "${ACT_SHARED_SECRET:-}" ]]; then
    if [[ -f "$SECRET_FILE" ]]; then
      ACT_SHARED_SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
    else
      umask 077
      openssl rand -hex 32 > "$SECRET_FILE"
      chmod 600 "$SECRET_FILE"
      ACT_SHARED_SECRET="$(tr -d '\r\n' < "$SECRET_FILE")"
      log "ACT_SHARED_SECRET generated in deploy/fly/.act_secret (mode 600, value not printed)."
      log "Store the same secret in the routine environment as ACT_SHARED_SECRET."
    fi
    export ACT_SHARED_SECRET
  fi
}

app_exists() {
  fly status -a "$APP" >/dev/null 2>&1
}

volume_exists() {
  fly volumes list -a "$APP" --json 2>/dev/null | VOLUME="$VOLUME" python3 -c '
import json, sys, os
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(1)
vs = json.loads(raw)
if isinstance(vs, dict):
    vs = vs.get("volumes") or vs.get("data") or []
name = os.environ.get("VOLUME", "bridge_data")
ok = any((v.get("name") or v.get("Name") or "") == name for v in vs)
sys.exit(0 if ok else 1)
'
}

prepare() {
  need_login
  ensure_secrets_in_env
  export APP
  if app_exists; then
    log "App $APP already exists."
  else
    log "Creating app $APP in org $ORG, region $REGION..."
    fly apps create "$APP" -o "$ORG" -y
  fi

  if volume_exists; then
    log "Volume $VOLUME already exists."
  else
    log "Creating volume $VOLUME (1GB) in $REGION..."
    fly volumes create "$VOLUME" -a "$APP" -r "$REGION" -s 1 -y
  fi

  log "Importing secrets (names only will appear; values are not printed)..."
  python3 - << 'PY' | fly secrets import --stage -a "$APP" -c "$CONFIG"
import os, sys
pairs = {
    "DISCORD_BOT_TOKEN": os.environ.get("DISCORD_BOT_TOKEN") or "",
    "ROUTINE_WEBHOOK_KEY": os.environ.get("ROUTINE_WEBHOOK_KEY") or os.environ.get("GROK_WEBHOOK_KEY") or "",
    "ROUTINE_WEBHOOK_URL": os.environ.get("ROUTINE_WEBHOOK_URL") or os.environ.get("GROK_WEBHOOK_URL") or "",
    "ACT_SHARED_SECRET": os.environ.get("ACT_SHARED_SECRET") or "",
}
for k, v in pairs.items():
    if not v or "\n" in v or "\r" in v or "\x00" in v:
        sys.stderr.write(f"error: invalid or missing {k}\n")
        sys.exit(1)
    sys.stdout.write(f"{k}={v}\n")
PY
  log "Prepare done. Secrets staged. No machine started."
}

seed_data() {
  need_login
  local tmp packed
  tmp="$(mktemp -d)"
  packed="$tmp/data.tgz"
  tar czf "$packed" -C "$ROOT/data" --exclude heartbeat --exclude '*.lock' --exclude '*.tmp' --exclude '.swapfile' .
  log "Uploading data/ seed to the machine (no secrets in this archive)..."
  fly ssh sftp put -a "$APP" -c "$CONFIG" "$packed" /tmp/data-seed.tgz
  fly ssh console -a "$APP" -c "$CONFIG" -C "bash -lc 'mkdir -p /app/data /app/data/memory && tar xzf /tmp/data-seed.tgz -C /app/data && rm -f /tmp/data-seed.tgz /app/data/heartbeat && chown -R node:node /app/data && ls /app/data'"
  rm -rf "$tmp"
  log "Restarting the machine so the gateway reloads seeded state..."
  fly machine restart -a "$APP" || true
}

deploy() {
  need_login
  ensure_secrets_in_env
  prepare

  log "Deploying (single machine, --ha=false, region $REGION)..."
  fly deploy "$ROOT" --config "$CONFIG" --dockerfile "$ROOT/deploy/fly/Dockerfile" --ha=false --yes --remote-only --depot=false

  log "Waiting for the machine to come up..."
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if fly status -a "$APP" 2>/dev/null | grep -qi 'started\|running\|deployed'; then
      break
    fi
    sleep 3
  done

  destroy_builder
  log "Deploy finished. Check logs with: fly logs -a $APP"
  log "Health: curl -sS https://$APP.fly.dev/health"
}

case "$CMD" in
  --prepare) prepare ;;
  --deploy) deploy ;;
  --seed) seed_data ;;
  --dry-run)
    log "Would use app=$APP org=$ORG region=$REGION volume=$VOLUME config=$CONFIG"
    log "flyctl: $(command -v flyctl)"
    fly auth whoami || true
    ;;
  *)
    echo "Usage: $0 --prepare | --deploy | --seed | --dry-run" >&2
    exit 2
    ;;
esac
