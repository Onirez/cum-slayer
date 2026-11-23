#!/usr/bin/env node
'use strict';
const { sanitizeMassMentions, splitContent, allowedMentions, discordRequest } = require('./lib');

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const userId = process.env.TARGET_USER_ID;
  const content = sanitizeMassMentions(process.env.TARGET_TEXT ?? '');
  if (!userId || !content.trim()) {
    console.error('Usage: dm.sh [--dry-run] <user_id> <text>');
    process.exit(2);
  }
  // Discord Agent Rules: DM only users who interacted with the bot first.
  if (!require('./scope').hasInteracted(userId)) {
    console.error('error: refused: no prior interaction with this user (DM rule, see AGENTS.md)');
    process.exit(3);
  }

  let channelId;
  if (dryRun) {
    console.log(`dry-run POST https://discord.com/api/v10/users/@me/channels`);
    console.log(JSON.stringify({ recipient_id: userId }));
    channelId = 'DRY_RUN_DM_CHANNEL';
  } else {
    const ch = await discordRequest({
      method: 'POST',
      path: '/users/@me/channels',
      body: { recipient_id: userId },
      dryRun: false,
    });
    channelId = ch.data?.id;
    if (!channelId) {
      console.error('error: failed to open DM channel');
      process.exit(1);
    }
  }
  
  const ids = [];
  for (const chunk of splitContent(content)) {
    const res = await discordRequest({
      method: 'POST',
      path: `/channels/${encodeURIComponent(channelId)}/messages`,
      body: { content: chunk, allowed_mentions: allowedMentions() },
      dryRun,
    });
    if (res.data?.id) ids.push(res.data.id);
  }
  if (!dryRun) console.log(`posted dm ids=${ids.join(',') || '(none)'} user=${userId} channel=${channelId}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
