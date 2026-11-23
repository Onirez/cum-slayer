#!/usr/bin/env bash
# Appelle un outil du pont à distance (POST /act ou /run).
# Usage :
#   remote-tool.sh act [--dry-run] < json
#   remote-tool.sh memory get <user_id>
#   remote-tool.sh user <get|history|note|unnote|forget|optout|optin|list> ...
# Secrets : ACT_SHARED_SECRET et ACT_REMOTE_URL dans l'environnement uniquement.
# Jamais passés en argv de curl, jamais journalisés.
set -euo pipefail
TOOL="${1:-}"
if [[ -z "$TOOL" ]]; then
  echo "Usage: $0 <act|memory|user|skills|context|dm|react|send|embed|mod|reply|roast_now> [args]" >&2
  exit 2
fi
shift
URL="${ACT_REMOTE_URL:-}"
if [[ -z "$URL" ]]; then
  echo "error: ACT_REMOTE_URL is not set (ex. https://cum-slayer-bridge.fly.dev)" >&2
  exit 1
fi
_HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ -z "${ACT_SHARED_SECRET:-}" && -f "$_HERE/.act_secret" ]]; then
  ACT_SHARED_SECRET="$(tr -d '\r\n' < "$_HERE/.act_secret")"
  export ACT_SHARED_SECRET
fi
if [[ -z "${ACT_SHARED_SECRET:-}" ]]; then
  echo "error: ACT_SHARED_SECRET is not set" >&2
  exit 1
fi

DRY=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY=1
  shift
fi

STDIN=""
if [[ "$TOOL" == "act" ]]; then
  STDIN="$(cat)"
elif [[ ! -t 0 ]]; then
  STDIN="$(cat)"
fi

_RT_ARGS_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[2:]))' x "$@")"
export _RT_URL="$URL" _RT_TOOL="$TOOL" _RT_DRY="$DRY" _RT_STDIN="$STDIN" _RT_ARGS_JSON
python3 - << 'PY'
import json, os, sys, urllib.request, urllib.error

url = os.environ["_RT_URL"].rstrip("/")
secret = os.environ["ACT_SHARED_SECRET"]
tool = os.environ["_RT_TOOL"]
dry = os.environ.get("_RT_DRY") == "1"
stdin = os.environ.get("_RT_STDIN", "")
args = json.loads(os.environ.get("_RT_ARGS_JSON", "[]"))

if tool == "act":
    req_url = url + "/act" + ("?dry_run=1" if dry else "")
    body = stdin.encode("utf-8")
else:
    req_url = url + "/run"
    body = json.dumps({"tool": tool, "args": args, "stdin": stdin, "dry_run": dry}).encode("utf-8")

req = urllib.request.Request(
    req_url,
    data=body,
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        raw = resp.read()
        status = resp.status
except urllib.error.HTTPError as e:
    raw = e.read() or b""
    status = e.code
except Exception as e:
    print(f"error: remote {tool} failed: {e}", file=sys.stderr)
    sys.exit(1)

try:
    data = json.loads(raw.decode("utf-8"))
except Exception:
    sys.stdout.buffer.write(raw)
    sys.exit(0 if 200 <= status < 300 else 1)

stdout = data.get("stdout") or ""
stderr = data.get("stderr") or ""
if stdout:
    sys.stdout.write(stdout if stdout.endswith("\n") else stdout + "\n")
if stderr:
    sys.stderr.write(stderr if stderr.endswith("\n") else stderr + "\n")
if data.get("timedOut"):
    print("error: remote tool timed out", file=sys.stderr)
    sys.exit(1)
ok = bool(data.get("ok", 200 <= status < 300))
code = data.get("status", 0 if ok else 1)
try:
    sys.exit(int(code))
except Exception:
    sys.exit(0 if ok else 1)
PY
