#!/usr/bin/env node
'use strict';
const { sanitizeMassMentions, splitContent, allowedMentions, discordRequest } = require('./lib');

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const channelId = process.env.TARGET_CHANNEL_ID;
  const content = sanitizeMassMentions(process.env.TARGET_TEXT ?? '');
  if (!channelId || !content.trim()) {
    console.error('Usage: send.sh [--dry-run] <channel_id> <text>');
    process.exit(2);
  }
  // Discord Agent Rules: no unsolicited messages outside AGENTS.
  try { await require('./scope').assertMaySpeakIn(channelId); } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
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
  if (!dryRun) console.log(`posted message ids=${ids.join(',') || '(none)'} channel=${channelId}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
