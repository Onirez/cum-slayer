#!/usr/bin/env node
'use strict';
const { sanitizeMassMentions, allowedMentions, discordRequest } = require('./lib');

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const channelId = process.env.TARGET_CHANNEL_ID;
  const userId = process.env.TARGET_USER_ID;
  if (!channelId && !userId) {
    console.error('Usage: embed.sh [--dry-run] (--channel-id ID | --user-id ID) [--title T] [--description D] [--color #RRGGBB] [--thumbnail URL] [--fields JSON]');
    process.exit(2);
  }
  if (channelId && userId) {
    console.error('error: provide exactly one of --channel-id or --user-id');
    process.exit(2);
  }
  // Discord Agent Rules (AGENTS.md): no unsolicited messages / DMs.
  try {
    const scope = require('./scope');
    if (userId && !scope.hasInteracted(userId)) throw new Error('refused: no prior interaction with this user (DM rule)');
    if (channelId) await scope.assertMaySpeakIn(channelId);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  
  const embed = {};
  if (process.env.EMBED_TITLE) embed.title = process.env.EMBED_TITLE.slice(0, 256);
  if (process.env.EMBED_DESCRIPTION) embed.description = sanitizeMassMentions(process.env.EMBED_DESCRIPTION).slice(0, 4096);
  if (process.env.EMBED_COLOR) {
    const hex = process.env.EMBED_COLOR.replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
      console.error('error: --color must be #RRGGBB');
      process.exit(2);
    }
    embed.color = parseInt(hex, 16);
  }
  if (process.env.EMBED_THUMBNAIL) embed.thumbnail = { url: process.env.EMBED_THUMBNAIL };
  if (process.env.EMBED_FIELDS) {
    try {
      const fields = JSON.parse(process.env.EMBED_FIELDS);
      if (!Array.isArray(fields) || fields.length > 25) throw new Error('fields must be an array of at most 25');
      embed.fields = fields.map((f) => ({
        name: String(f.name ?? '').slice(0, 256),
        value: sanitizeMassMentions(String(f.value ?? '')).slice(0, 1024),
        inline: Boolean(f.inline),
      }));
    } catch (err) {
      console.error(`error: invalid --fields JSON: ${err.message}`);
      process.exit(2);
    }
  }
  if (!embed.title && !embed.description && !embed.fields) {
    console.error('error: provide at least --title, --description or --fields');
    process.exit(2);
  }
  
  let destChannel = channelId;
  if (userId && !dryRun) {
    const ch = await discordRequest({
      method: 'POST',
      path: '/users/@me/channels',
      body: { recipient_id: userId },
      dryRun: false,
    });
    destChannel = ch.data?.id;
  } else if (userId && dryRun) {
    console.log('dry-run POST https://discord.com/api/v10/users/@me/channels');
    console.log(JSON.stringify({ recipient_id: userId }));
    destChannel = 'DRY_RUN_DM_CHANNEL';
  }
  
  const res = await discordRequest({
    method: 'POST',
    path: `/channels/${encodeURIComponent(destChannel)}/messages`,
    body: { embeds: [embed], allowed_mentions: allowedMentions() },
    dryRun,
  });
  if (!dryRun) console.log(`posted embed id=${res.data?.id || ''} channel=${destChannel}`);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
