#!/usr/bin/env bash
# Reply to a Discord message via REST v10.
# Usage: reply.sh [--dry-run] <channel_id> <message_id> <text>
# Reads DISCORD_BOT_TOKEN from the environment only; never prints it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$ROOT/src"

if [[ -n "${ACT_REMOTE_URL:-}" && -n "${ACT_SHARED_SECRET:-}" ]]; then
  _tool="$(basename "$0" .sh)"
  exec "$ROOT/deploy/fly/remote-tool.sh" "$_tool" "$@"
fi
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
  shift
fi

if [[ $# -lt 3 ]]; then
  echo "Usage: $0 [--dry-run] <channel_id> <message_id> <text>" >&2
  exit 2
fi

CHANNEL_ID="$1"
MESSAGE_ID="$2"
shift 2
TEXT="$*"

if [[ -z "${DISCORD_BOT_TOKEN:-}" && "$DRY_RUN" -ne 1 ]]; then
  echo "error: DISCORD_BOT_TOKEN is not set" >&2
  exit 1
fi

node "$SRC/guard.js" speak "$CHANNEL_ID" "$MESSAGE_ID"

export REPLY_CHANNEL_ID="$CHANNEL_ID"
export REPLY_MESSAGE_ID="$MESSAGE_ID"
export REPLY_TEXT="$TEXT"
export REPLY_DRY_RUN="$DRY_RUN"

node << 'NODE'
function sanitizeMassMentions(text) {
  return String(text ?? '').replace(/@(everyone|here)/giu, '@{$1}');
}

async function main() {
  const channelId = process.env.REPLY_CHANNEL_ID;
  const messageId = process.env.REPLY_MESSAGE_ID;
  let text = sanitizeMassMentions(process.env.REPLY_TEXT ?? '');
  const dryRun = process.env.REPLY_DRY_RUN === '1';

  if (text.length > 2000) {
    text = text.slice(0, 2000);
  }

  const body = {
    content: text,
    message_reference: {
      message_id: messageId,
      channel_id: channelId,
      fail_if_not_exists: false,
    },
    allowed_mentions: {
      parse: [],
      replied_user: true,
    },
  };

  const json = JSON.stringify(body);
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;

  if (dryRun) {
    console.log('dry-run POST', url);
    console.log(json);
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('error: DISCORD_BOT_TOKEN is not set');
    process.exit(1);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: json,
  });

  const respText = await res.text();
  if (!res.ok) {
    console.error(`Discord API error status=${res.status} body=${respText.slice(0, 500)}`);
    process.exit(1);
  }

  let id = '';
  try {
    id = JSON.parse(respText).id || '';
  } catch {
    // ignore parse failure; still treat as success if HTTP ok
  }
  console.log(`posted reply id=${id} channel=${channelId} ref=${messageId}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
NODE
