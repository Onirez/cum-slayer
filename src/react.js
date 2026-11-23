#!/usr/bin/env node
'use strict';
const { encodeReactionEmoji, discordRequest } = require('./lib');

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const channelId = process.env.TARGET_CHANNEL_ID;
  const messageId = process.env.TARGET_MESSAGE_ID;
  const emoji = process.env.TARGET_EMOJI;
  if (!channelId || !messageId || !emoji) {
    console.error('Usage: react.sh [--dry-run] <channel_id> <message_id> <emoji>');
    process.exit(2);
  }
  
  // Discord Agent Rules (AGENTS.md): no unsolicited intervention outside AGENTS.
  try {
    const scope = require('./scope');
    if (!scope.triggerRecord(messageId)) await scope.assertMaySpeakIn(channelId);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  const encoded = encodeReactionEmoji(emoji);
  await discordRequest({
    method: 'PUT',
    path: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encoded}/@me`,
    dryRun,
  });
  if (!dryRun) console.log(`reacted channel=${channelId} message=${messageId} emoji=${emoji}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
