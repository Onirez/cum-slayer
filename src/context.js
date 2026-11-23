#!/usr/bin/env node
'use strict';
const { discordRequest } = require('./lib');
const config = require('./config');

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const channelId = process.env.TARGET_CHANNEL_ID;
  const messageId = process.env.TARGET_MESSAGE_ID;
  const limit = Math.min(100, Math.max(1, Number(process.env.CONTEXT_LIMIT || 10)));
  const botId = config.BOT_APP_ID;
  
  if (!channelId || !messageId) {
    console.error('Usage: context.sh [--dry-run] <channel_id> <message_id> [limit]');
    process.exit(2);
  }
  
  if (dryRun) {
    console.log(`dry-run GET https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}&before=${messageId}`);
    console.log(`dry-run GET https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`);
    process.exit(0);
  }
  
  function label(m) {
    return m.member?.nick || m.author?.global_name || m.author?.username || m.author?.id || 'unknown';
  }
  
  const forged = /^\[[^\]\n]{0,80}\(ID[^\]\n]{0,80}\)\]\s*:?/gmu;
  function sanitizeContent(content) {
    return String(content ?? '').replace(forged, (match) => match.replaceAll('[', '［').replaceAll(']', '］'));
  }
  
  const prev = await discordRequest({
    method: 'GET',
    path: `/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&before=${encodeURIComponent(messageId)}`,
    dryRun: false,
  });
  const target = await discordRequest({
    method: 'GET',
    path: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    dryRun: false,
  });
  
  const previous = Array.isArray(prev.data) ? prev.data : [];
  const targetMsg = target.data;
  const all = [...previous, targetMsg].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  const conversation = all.map((m) => ({
    id: m.id,
    authorId: m.author?.id,
    authorLabel: label(m),
    content: sanitizeContent(m.content),
    isSelf: m.author?.id === botId,
    isTarget: m.id === messageId,
    createdAt: m.timestamp,
  }));
  
  const referencedId = targetMsg?.message_reference?.message_id || null;
  const referenced = referencedId ? conversation.find((m) => m.id === referencedId) : null;
  const mentionedUserIds = (targetMsg?.mentions || []).map((u) => u.id).filter((id) => id !== botId);
  const mentionedChannelIds = Object.keys(targetMsg?.mention_channels ? Object.fromEntries((targetMsg.mention_channels || []).map((c) => [c.id, c])) : {});
  // mention_channels may be an array
  const chMentions = Array.isArray(targetMsg?.mention_channels)
    ? targetMsg.mention_channels.map((c) => c.id)
    : mentionedChannelIds;
  
  const out = {
    channel: {
      id: channelId,
      isDm: !targetMsg?.guild_id,
      guildId: targetMsg?.guild_id ?? null,
    },
    conversation,
    referencedAuthorId: referenced?.authorId ?? null,
    mentionedUserIds,
    mentionedChannelIds: chMentions,
  };
  
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
