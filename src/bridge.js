'use strict';

/**
 * Discord gateway bridge: forwards triggers to an AI routine webhook.
 * Secrets (DISCORD_BOT_TOKEN, ROUTINE_WEBHOOK_URL, ROUTINE_WEBHOOK_KEY) are
 * read from the environment only and must never be logged or written to disk.
 */

const { Client, GatewayIntentBits, Partials, ActivityType } = require('discord.js');
// Voice presence is done with raw gateway op 4 only (no @discordjs/voice):
// the voice websocket cannot complete TLS from this box, and the library's
// endless signalling/connecting retry loop was the prime suspect of the
// 22:21 hang. Being "in" the channel only needs the gateway voice state.
const fs = require('fs');
const path = require('path');
// Discord Agent Rules (AGENTS.md): scope, explicit mentions, DM interactions.
const scope = require('./scope');
const { AGENTS_CATEGORY_ID } = scope;
const roast = require('./roast');
const userMem = require('./usermem');
const images = require('./images');
const restart = require('./restart');
const slash = require('./slash');
const config = require('./config');
const CREATOR_USER_ID = config.CREATOR_ID;

const DATA_DIR = config.DATA_DIR;
const MEMORY_DIR = config.MEMORY_DIR;
const SKILLS_FILE = config.SKILLS_FILE;
const TRIGGERS_FILE = config.TRIGGERS_FILE;
const STATUSES_FILE = config.STATUSES_FILE;
const STATUS_OVERRIDE_FILE = config.STATUS_OVERRIDE_FILE;
const PRESENCE_TZ = 'Europe/Paris';
const PRESENCE_SEED = 0xC0451A11;
const PRESENCE_TYPES = new Set(['Playing', 'Listening', 'Watching', 'Competing', 'Custom']);
const PRESENCE_LABELS = {
  Playing: 'Joue à',
  Listening: 'Écoute',
  Watching: 'Regarde',
  Competing: 'Participe à',
  Custom: 'Statut',
};
const GUILD_INFO_TTL_MS = 5 * 60 * 1000;
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 90_000;
const RECENT_LIMIT = 10;
const CONTENT_TRUNCATE = 1_500;
const PAYLOAD_MAX_CHARS = 80_000;
const USERMEM_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.USERMEM ?? 'on').trim().toLowerCase(),
);
const USERMEM_AUTHOR_LIMIT = Number(process.env.USERMEM_AUTHOR_LIMIT || 15);
const USERMEM_OTHER_LIMIT = Number(process.env.USERMEM_OTHER_LIMIT || 6);
const USERMEM_THROWBACK = !['0', 'false', 'no', 'off'].includes(
  String(process.env.USERMEM_THROWBACK ?? 'on').trim().toLowerCase(),
);
const THROWBACK_HINT = 'Vieux message de cette personne, remonté au hasard (rare). Tu PEUX t\'en servir pour un callback ou une pique si ça colle naturellement à la conversation ; sinon ignore-le complètement.';
const USERMEM_HINT = 'Contexte de fond. À utiliser rarement : seulement si ça rend la réponse plus juste (callback précis, comprendre de quoi la personne parle). Ne jamais réciter ni lister ce qui est su.';

const USER_COOLDOWN_MS = config.USER_COOLDOWN_MS;
const GLOBAL_WINDOW_MS = config.GLOBAL_WINDOW_MS;
const GLOBAL_MAX = config.GLOBAL_MAX;
const WEBHOOK_TIMEOUT_MS = config.WEBHOOK_TIMEOUT_MS;
const BOT_APP_ID = config.BOT_APP_ID;
const ALLOW_DMS = config.ALLOW_DMS;
const AUTO_VOICE = config.AUTO_VOICE;
const AUTO_VOICE_DEBOUNCE_MS = config.AUTO_VOICE_DEBOUNCE_MS;
const AUTO_VOICE_RESYNC_MS = config.AUTO_VOICE_RESYNC_MS;
const VOICE_CHANNEL_TYPE = 2;
const STAGE_CHANNEL_TYPE = 13;
const VOICE_TYPES = new Set([VOICE_CHANNEL_TYPE, STAGE_CHANNEL_TYPE]);

/** Is this guild channel (or thread) inside the AGENTS category? */
function channelInAgents(guild, channelId) {
  if (!guild || !channelId) return false;
  return scope.isInAgents(String(channelId), (id) => {
    const c = guild.channels.cache.get(id);
    return c ? { id: c.id, type: c.type, parent_id: c.parentId || null } : null;
  });
}

const allowedGuilds = new Set(config.ALLOWED_GUILDS);

const botAliases = config.BOT_ALIASES.slice();

const userCooldowns = new Map(); // userId -> last trigger ts
let lastRestartAt = 0;
const botLoopGuard = new scope.BotLoopGuard({
  maxPerWindow: config.BOT_LOOP_MAX,
  idleMs: config.BOT_LOOP_IDLE_MS,
  authorCooldownMs: config.BOT_AUTHOR_COOLDOWN_MS,
});
const globalHits = []; // timestamps of recent triggers
const typingLoops = new Map(); // channelId -> { interval, timeout }

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

function stopTypingLoop(channelId) {
  const loop = typingLoops.get(channelId);
  if (!loop) return;
  clearInterval(loop.interval);
  clearTimeout(loop.timeout);
  typingLoops.delete(channelId);
}

function startTypingLoop(channel) {
  const channelId = channel.id;
  stopTypingLoop(channelId);
  const ping = () => {
    channel.sendTyping().catch((err) => {
      log(`warn: sendTyping failed in channel ${channelId}: ${err.message}`);
    });
  };
  ping();
  const interval = setInterval(ping, TYPING_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  const timeout = setTimeout(() => stopTypingLoop(channelId), TYPING_MAX_MS);
  if (typeof timeout.unref === 'function') timeout.unref();
  typingLoops.set(channelId, { interval, timeout });
}

function stopAllTypingLoops() {
  for (const channelId of [...typingLoops.keys()]) stopTypingLoop(channelId);
}

function readMemoryFile(userId) {
  const file = path.join(MEMORY_DIR, `${userId}.json`);
  try {
    if (!fs.existsSync(file)) {
      return { userId, memoryText: null, updatedAt: null };
    }
    const mem = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      userId,
      memoryText: mem.memoryText ? truncate(mem.memoryText, 2000) : null,
      updatedAt: mem.updatedAt || null,
    };
  } catch (err) {
    log(`warn: failed to read memory for user ${userId}: ${err.message}`);
    return { userId, memoryText: null, updatedAt: null };
  }
}

function loadActiveSkills() {
  try {
    if (!fs.existsSync(SKILLS_FILE)) return [];
    const doc = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'));
    const skills = Array.isArray(doc.skills) ? doc.skills : [];
    return skills
      .filter((s) => s && !s.deletedAt)
      .map((s) => ({
        id: s.id,
        trigger: truncate(s.trigger || '', 120),
        rule: truncate(s.rule || '', 600),
      }));
  } catch (err) {
    log(`warn: failed to read skills.json: ${err.message}`);
    return [];
  }
}

function collectMentionedUserIds(message, botId) {
  const ids = new Set();
  for (const id of message.mentions.users.keys()) ids.add(id);
  const raw = message.content || '';
  for (const match of raw.matchAll(/<@!?(\d{5,30})>/g)) ids.add(match[1]);
  if (botId) ids.delete(botId);
  ids.delete(message.author.id);
  return [...ids];
}

function loadPrefetchedMemory(message, botId) {
  const mentioned = collectMentionedUserIds(message, botId).map(readMemoryFile);
  return {
    author: readMemoryFile(message.author.id),
    mentioned,
  };
}

/** Per-user context (background) for the author + mentioned/replied users. */
function loadUserContext(message, botId, referenced, trigger) {
  if (!USERMEM_ENABLED || !message.guildId) return null;
  try {
    const author = userMem.contextFor(message.author.id, { limit: USERMEM_AUTHOR_LIMIT, excludeId: message.id, max: 220, role: 'author' });
    if (USERMEM_THROWBACK && trigger && trigger !== 'daily_roast') {
      const tb = userMem.maybeThrowback(message.author.id);
      if (tb) {
        author.throwback = { ...tb, hint: THROWBACK_HINT };
        log(`throwback user=${message.author.id} from=${tb.t}`);
      }
    }
    const others = [];
    const seen = new Set([message.author.id, botId].filter(Boolean));
    const add = (id, role) => {
      if (!id || seen.has(id) || others.length >= 3 || !/^\d{5,30}$/.test(id)) return;
      seen.add(id);
      const ctx = userMem.contextFor(id, { limit: USERMEM_OTHER_LIMIT, max: 160, role });
      if (ctx.notes.length || ctx.recent.length) others.push(ctx);
    };
    add(referenced?.author_id, 'replied_to');
    for (const id of collectMentionedUserIds(message, botId)) add(id, 'mentioned');
    return { usage: USERMEM_HINT, author, others };
  } catch (err) {
    log(`warn: user context failed: ${err.message}`);
    return null;
  }
}

function shrinkPayload(payload) {
  let json = JSON.stringify(payload);
  if (json.length <= PAYLOAD_MAX_CHARS) return payload;
  if (payload.users) {
    payload.users.others = (payload.users.others || []).slice(0, 1);
    if (payload.users.author?.recent) payload.users.author.recent = payload.users.author.recent.slice(-8);
  }
  if (Array.isArray(payload.recent)) {
    for (const item of payload.recent) {
      if (item && item.content) item.content = truncate(item.content, 400);
    }
  }
  if (payload.content) payload.content = truncate(payload.content, 800);
  if (payload.referenced && payload.referenced.content) {
    payload.referenced.content = truncate(payload.referenced.content, 400);
  }
  json = JSON.stringify(payload);
  if (json.length > PAYLOAD_MAX_CHARS && payload.memory && Array.isArray(payload.memory.mentioned)) {
    payload.memory.mentioned = payload.memory.mentioned.slice(0, 3);
  }
  json = JSON.stringify(payload);
  if (json.length > PAYLOAD_MAX_CHARS && Array.isArray(payload.recent) && payload.recent.length > 6) {
    payload.recent = payload.recent.slice(-6);
  }
  return payload;
}

// ---- compact guild info for targeting (cached) ----
const CH_KIND = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum', 16: 'media' };
const guildInfoCache = new Map(); // guildId -> { at, info }

function compactGuildInfo(guildId) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return null;
  const cached = guildInfoCache.get(guildId);
  let base;
  if (cached && Date.now() - cached.at < GUILD_INFO_TTL_MS) {
    base = cached.info;
  } else {
    const roles = [...guild.roles.cache.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .slice(0, 60)
      .map((r) => (r.permissions.has('Administrator') ? { id: r.id, name: truncate(r.name, 40), admin: true } : { id: r.id, name: truncate(r.name, 40) }));
    const channels = [...guild.channels.cache.values()]
      .filter((c) => c.type in CH_KIND)
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .slice(0, 80)
      .map((c) => (channelInAgents(guild, c.id) ? { id: c.id, name: truncate(c.name, 40), t: CH_KIND[c.type], agents: true } : { id: c.id, name: truncate(c.name, 40), t: CH_KIND[c.type] }));
    base = { id: guild.id, owner_id: guild.ownerId, roles, channels };
    guildInfoCache.set(guildId, { at: Date.now(), info: base });
  }
  const voice = [...guild.voiceStates.cache.values()]
    .filter((v) => v.channelId)
    .slice(0, 40)
    .map((v) => ({ user_id: v.id, channel_id: v.channelId }));
  const members = [...guild.members.cache.values()]
    .filter((m) => !m.user.bot)
    .slice(0, 150)
    .map((m) => {
      const o = { id: m.id, name: truncate(m.displayName || m.user.username, 32) };
      if (m.user.username && m.user.username !== o.name) o.u = truncate(m.user.username, 32);
      const st = m.presence?.status;
      if (st && st !== 'offline') o.s = st;
      return o;
    });
  return { ...base, voice, members };
}

function compactMentions(message, botId) {
  const users = [];
  for (const [id, u] of message.mentions.users) {
    if (id === botId) continue;
    users.push({ id, name: truncate(message.guild?.members?.cache.get(id)?.displayName || u.globalName || u.username || id, 40) });
  }
  const roles = [...message.mentions.roles.values()].map((r) => ({ id: r.id, name: truncate(r.name, 40) }));
  const channels = [...message.mentions.channels.values()].map((c) => ({ id: c.id, name: truncate(c.name || '', 40) }));
  return { users, roles, channels };
}

function recordTrigger(message, trigger) {
  try {
    let doc = { triggers: [] };
    try { doc = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8')); } catch { /* new file */ }
    const list = Array.isArray(doc.triggers) ? doc.triggers : [];
    list.push({
      message_id: message.id,
      channel_id: message.channelId,
      guild_id: message.guildId || null,
      author_id: message.author.id,
      trigger,
      at: Date.now(),
    });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${TRIGGERS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ triggers: list.slice(-300) }));
    fs.renameSync(tmp, TRIGGERS_FILE);
  } catch (err) {
    log(`warn: failed to record trigger: ${err.message}`);
  }
  try {
    scope.recordInteraction(message.author.id, `trigger:${trigger}`);
  } catch (err) {
    log(`warn: failed to record interaction: ${err.message}`);
  }
}

function localTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`;
}

function log(message) {
  // Supervisor redirects stdout/stderr to bridge.log; do not also append here.
  console.log(`${localTs()} ${message}`);
}

function webhookConfigured() {
  return Boolean(config.ROUTINE_WEBHOOK_URL && config.ROUTINE_WEBHOOK_KEY);
}

function resolveContent(message) {
  let content = message.content || '';
  for (const [id, user] of message.mentions.users) {
    const name = user.globalName || user.username || id;
    content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
  }
  for (const [id, role] of message.mentions.roles) {
    const name = role.name || id;
    content = content.replace(new RegExp(`<@&${id}>`, 'g'), `@${name}`);
  }
  for (const [id, channel] of message.mentions.channels) {
    const name = channel.name || id;
    content = content.replace(new RegExp(`<#${id}>`, 'g'), `#${name}`);
  }
  return content;
}

function authorName(message) {
  return (
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username ||
    'unknown'
  );
}

function fold(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function stripCodeBlocks(content) {
  return String(content || '').replace(/```[\s\S]*?```|`[^`\n]*`/gu, '');
}

function hasKeyword(content) {
  if (!content) return false;
  const normalized = fold(content);
  return /c[uû]m/i.test(content) || /cum/i.test(normalized);
}

function hasBotAlias(content) {
  const text = fold(stripCodeBlocks(content));
  if (!text || botAliases.length === 0) return false;
  for (const alias of botAliases) {
    const escaped = fold(alias).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!escaped) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
    if (pattern.test(text)) return true;
  }
  return false;
}

function isBotMentioned(message, client) {
  if (!client.user) return false;
  if (message.mentions.users.has(client.user.id)) return true;
  const botRole = message.guild?.members?.me?.roles?.botRole;
  if (botRole && message.mentions.roles.has(botRole.id)) return true;
  for (const role of message.mentions.roles.values()) {
    if (role.tags?.botId === client.user.id) return true;
  }
  return false;
}

function hasExplicitMentionToken(message, botRoleIds) {
  if (!client.user) return false;
  return scope.hasExplicitMention(message.content || '', client.user.id, botRoleIds);
}

async function isReplyToBot(message, client) {
  if (!client.user) return false;
  if (message.mentions.repliedUser?.id === client.user.id) return true;
  const refId = message.reference?.messageId;
  if (!refId) return false;
  try {
    const ref = await message.channel.messages.fetch(refId);
    return ref.author?.id === client.user.id;
  } catch {
    return false;
  }
}

async function userSharesAllowedGuild(userId) {
  for (const guildId of allowedGuilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    if (guild.members.cache.has(userId)) return true;
    try {
      await guild.members.fetch(userId);
      return true;
    } catch {
      // Not a member, or fetch failed.
    }
  }
  return false;
}

function checkRateLimits(userId) {
  const now = Date.now();
  const last = userCooldowns.get(userId) || 0;
  if (now - last < USER_COOLDOWN_MS) {
    return { ok: false, reason: `user cooldown (${USER_COOLDOWN_MS}ms)` };
  }
  while (globalHits.length && now - globalHits[0] > GLOBAL_WINDOW_MS) {
    globalHits.shift();
  }
  if (globalHits.length >= GLOBAL_MAX) {
    return {
      ok: false,
      reason: `global rate limit (${GLOBAL_MAX} per ${GLOBAL_WINDOW_MS}ms)`,
    };
  }
  return { ok: true };
}

function markTriggered(userId) {
  const now = Date.now();
  userCooldowns.set(userId, now);
  globalHits.push(now);
  if (userCooldowns.size > 2000) {
    for (const [id, ts] of userCooldowns) {
      if (now - ts > USER_COOLDOWN_MS * 2) userCooldowns.delete(id);
    }
  }
}

function toRecentItem(m) {
  return {
    author: authorName(m),
    author_id: m.author?.id || null,
    content: truncate(resolveContent(m), CONTENT_TRUNCATE),
  };
}

async function recentMessages(message, limit = RECENT_LIMIT) {
  try {
    const fetched = await message.channel.messages.fetch({ limit });
    return [...fetched.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(toRecentItem);
  } catch (err) {
    log(`warn: failed to fetch recent messages in channel ${message.channelId}: ${err.message}`);
    return [toRecentItem(message)];
  }
}

async function getReferenced(message) {
  const refId = message.reference?.messageId;
  if (!refId) return null;
  try {
    const ref = await message.channel.messages.fetch(refId);
    const out = {
      message_id: ref.id,
      author_id: ref.author?.id || null,
      author: authorName(ref),
      content: truncate(resolveContent(ref), CONTENT_TRUNCATE),
    };
    return images.withImages(out, ref, true);
  } catch {
    const user = message.mentions.repliedUser;
    return {
      message_id: refId,
      author_id: user?.id || null,
      author: user ? (user.globalName || user.username || null) : null,
      content: null,
    };
  }
}

async function postWebhook(payload) {
  const url = config.ROUTINE_WEBHOOK_URL;
  const key = config.ROUTINE_WEBHOOK_KEY;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    const snippet = text.replace(/\s+/g, ' ').slice(0, 200);
    log(`webhook POST status=${res.status} body=${snippet || '(empty)'}`);
    return res.ok;
  } catch (err) {
    log(`webhook POST failed: ${err.name}: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (!process.env.DISCORD_BOT_TOKEN) {
  log('error: DISCORD_BOT_TOKEN is not set; exiting');
  process.exit(1);
}

if (!webhookConfigured()) {
  log('warn: ROUTINE_WEBHOOK_URL and/or ROUTINE_WEBHOOK_KEY are not set; triggers will be logged but not posted. Restart after setting them in the environment.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.Channel],
});

let autoVoiceTimer = null;
let autoVoiceInterval = null;
const autoVoiceSyncing = new Set();
const autoVoiceAsserted = new Map(); // guildId -> channelId asserted by this process

function sendVoiceStateUpdate(guild, channelId) {
  if (!guild.shard) {
    throw new Error(`no shard for guild ${guild.id}`);
  }
  return guild.shard.send({
    op: 4,
    d: {
      guild_id: guild.id,
      channel_id: channelId,
      self_mute: false, // mic unmuted (approved by the creator, AGENTS.md exceptions)
      self_deaf: true,
    },
  });
}

function botVoiceChannelId(guild) {
  const botId = client.user?.id;
  if (!botId) return null;
  return (
    guild.voiceStates.cache.get(botId)?.channelId ||
    null
  );
}

function humanCountsByChannel(guild) {
  const botId = client.user?.id;
  const afkId = guild.afkChannelId || null;
  const counts = new Map();
  for (const vs of guild.voiceStates.cache.values()) {
    if (!vs.channelId) continue;
    if (afkId && vs.channelId === afkId) continue;
    if (botId && vs.id === botId) continue;
    const member = vs.member || guild.members.cache.get(vs.id);
    const user = member?.user || client.users.cache.get(vs.id);
    if (user?.bot) continue;
    const channel = guild.channels.cache.get(vs.channelId);
    if (!channel || !VOICE_TYPES.has(channel.type)) continue;
    // Creator-approved exception (AGENTS.md): every voice/stage channel counts.
    counts.set(vs.channelId, (counts.get(vs.channelId) || 0) + 1);
  }
  return { counts, afkId };
}

function formatVoiceCounts(guild, counts) {
  const parts = [];
  for (const [id, n] of counts) {
    const name = guild.channels.cache.get(id)?.name || 'unknown';
    parts.push(`${name}(${id}):${n}`);
  }
  return parts.join(',') || '(none)';
}

function pickTargetChannel(guild) {
  const { counts, afkId } = humanCountsByChannel(guild);
  const currentRaw = botVoiceChannelId(guild);
  const currentId = currentRaw && currentRaw !== afkId ? currentRaw : null;
  const currentCount = currentId ? counts.get(currentId) || 0 : 0;

  let bestCount = 0;
  for (const n of counts.values()) {
    if (n > bestCount) bestCount = n;
  }

  if (bestCount === 0) {
    return { targetId: null, targetCount: 0, currentId, currentCount, counts, afkId };
  }

  // Hysteresis: only move if another channel has strictly more humans.
  if (currentId && currentCount > 0 && currentCount === bestCount) {
    return { targetId: currentId, targetCount: currentCount, currentId, currentCount, counts, afkId };
  }

  let chosen = null;
  for (const [channelId, n] of counts) {
    if (n !== bestCount) continue;
    if (!chosen || channelId < chosen) chosen = channelId;
  }
  return { targetId: chosen, targetCount: bestCount, currentId, currentCount, counts, afkId };
}

const autoVoiceLastSent = new Map(); // guildId -> { channelId, at }

function joinOrMoveVoice(guild, channel) {
  sendVoiceStateUpdate(guild, channel.id);
  autoVoiceLastSent.set(guild.id, { channelId: channel.id, at: Date.now() });
}

const voiceLeaveFallbackAt = new Map(); // guildId -> ts of last REST fallback

function leaveVoice(guild) {
  autoVoiceAsserted.delete(guild.id);
  try {
    sendVoiceStateUpdate(guild, null);
    autoVoiceLastSent.set(guild.id, { channelId: null, at: Date.now() });
  } catch (err) {
    log(`auto-voice warn: leave op4 failed guild=${guild.id}: ${err.message}`);
  }
  // A voice state left over from a previous gateway session ignores op 4 from
  // this one. When auto-voice decides to leave (nobody left in voice), fall
  // back to disconnecting the bot itself over REST (self only).
  const last = voiceLeaveFallbackAt.get(guild.id) || 0;
  if (Date.now() - last < 60_000) return;
  voiceLeaveFallbackAt.set(guild.id, Date.now());
  setTimeout(async () => {
    try {
      const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
      const st = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/voice-states/@me`, { headers });
      if (st.status !== 200) return;
      const vs = await st.json().catch(() => null);
      if (!vs?.channel_id) return;
      const target = guild.channels.cache.get(vs.channel_id);
      if (target && autoVoiceAsserted.get(guild.id) === vs.channel_id) return;
      const res = await fetch(`https://discord.com/api/v10/guilds/${guild.id}/members/${client.user.id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': encodeURIComponent('cûm slayer: quitte le vocal hors AGENTS (règles agents)') },
        body: JSON.stringify({ channel_id: null }),
      });
      log(`auto-voice self-disconnect REST guild=${guild.id} from=${vs.channel_id} status=${res.status}`);
    } catch (err) {
      log(`auto-voice warn: self-disconnect fallback failed guild=${guild.id}: ${err.message}`);
    }
  }, 8_000);
}

function syncAutoVoiceGuild(guild, reason) {
  if (autoVoiceSyncing.has(guild.id)) {
    scheduleAutoVoice(`${reason}-retry`);
    return;
  }
  autoVoiceSyncing.add(guild.id);
  try {
    const pick = pickTargetChannel(guild);
    const { targetId, targetCount, currentId, counts, afkId } = pick;
    const inChannel = currentId;

    if (reason === 'ready' || reason === 'shardReady') {
      log(
        `auto-voice snapshot guild=${guild.id} bot_in=${inChannel || 'none'} target=${targetId || 'none'} counts=${formatVoiceCounts(guild, counts)} afk=${afkId || 'none'} reason=${reason}`,
      );
    }

    if (!targetId) {
      if (inChannel || autoVoiceAsserted.has(guild.id)) {
        log(
          `auto-voice leave guild=${guild.id} from=${inChannel || 'unknown'} reason=${reason} counts=${formatVoiceCounts(guild, counts)}`,
        );
        leaveVoice(guild);
      }
      return;
    }

    const vs = guild.voiceStates.cache.get(client.user?.id);
    const gatewayThere = vs?.channelId === targetId;
    const alreadyAsserted = autoVoiceAsserted.get(guild.id) === targetId;
    // Stay without a new handshake only if THIS process already asserted the
    // state. After a restart the cache can still show the old voice state,
    // and skipping the join would leave the bot silent once that expires.
    if (gatewayThere && alreadyAsserted) {
      if (vs && (vs.selfMute === true || vs.selfDeaf === false)) {
        log(`auto-voice re-assert mute state (mic on, deaf)  guild=${guild.id} channel=${targetId} reason=${reason}`);
        try { sendVoiceStateUpdate(guild, targetId); } catch (err) {
          log(`auto-voice warn: remute failed: ${err.message}`);
        }
      }
      return;
    }

    const last = autoVoiceLastSent.get(guild.id);
    if (!gatewayThere && last && last.channelId === targetId && Date.now() - last.at < 15_000) {
      return; // op 4 just sent, wait for the gateway VOICE_STATE_UPDATE
    }

    const channel = guild.channels.cache.get(targetId);
    if (!channel || !VOICE_TYPES.has(channel.type)) {
      log(`auto-voice skip guild=${guild.id} target=${targetId} reason=missing-or-not-voice`);
      return;
    }
    if (channel.joinable === false) {
      log(`auto-voice skip guild=${guild.id} channel=${channel.name}(${channel.id}) reason=not-joinable`);
      return;
    }

    if (inChannel && inChannel !== targetId) {
      log(
        `auto-voice move guild=${guild.id} from=${inChannel} to=${channel.name}(${channel.id}) humans=${targetCount} reason=${reason} counts=${formatVoiceCounts(guild, counts)}`,
      );
    } else if (inChannel) {
      log(
        `auto-voice re-assert guild=${guild.id} channel=${channel.name}(${channel.id}) humans=${targetCount} reason=${reason} counts=${formatVoiceCounts(guild, counts)}`,
      );
    } else {
      log(
        `auto-voice join guild=${guild.id} channel=${channel.name}(${channel.id}) humans=${targetCount} reason=${reason} counts=${formatVoiceCounts(guild, counts)}`,
      );
    }
    joinOrMoveVoice(guild, channel);
    autoVoiceAsserted.set(guild.id, targetId);
  } finally {
    autoVoiceSyncing.delete(guild.id);
  }
}

function syncAutoVoice(reason) {
  if (!AUTO_VOICE) return;
  if (!client.user) return;
  for (const guildId of allowedGuilds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    try {
      syncAutoVoiceGuild(guild, reason);
    } catch (err) {
      log(`auto-voice error guild=${guild.id} reason=${reason}: ${err.message}`);
    }
  }
}

function scheduleAutoVoice(reason) {
  if (!AUTO_VOICE) return;
  if (autoVoiceTimer) clearTimeout(autoVoiceTimer);
  autoVoiceTimer = setTimeout(() => {
    autoVoiceTimer = null;
    try {
      syncAutoVoice(reason);
    } catch (err) {
      log(`auto-voice sync error: ${err.message}`);
    }
  }, AUTO_VOICE_DEBOUNCE_MS);
  if (typeof autoVoiceTimer.unref === 'function') autoVoiceTimer.unref();
}

function startAutoVoiceResync() {
  if (!AUTO_VOICE) return;
  if (autoVoiceInterval) clearInterval(autoVoiceInterval);
  autoVoiceInterval = setInterval(() => {
    try {
      syncAutoVoice('resync');
    } catch (err) {
      log(`auto-voice resync error: ${err.message}`);
    }
  }, AUTO_VOICE_RESYNC_MS);
}

function stopAutoVoice() {
  if (autoVoiceTimer) {
    clearTimeout(autoVoiceTimer);
    autoVoiceTimer = null;
  }
  if (autoVoiceInterval) {
    clearInterval(autoVoiceInterval);
    autoVoiceInterval = null;
  }
}


// ---- daily presence (Europe/Paris midnight, deterministic cycle) ----
let presenceTimer = null;

function parisParts(date) {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: PRESENCE_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  return parts;
}

function parisDateKey(date = new Date()) {
  const p = parisParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const p = parisParts(new Date(utc));
    const asUtc = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = target - asUtc;
    if (diff === 0) break;
    utc += diff;
  }
  return utc;
}

function parisDayNumber(date = new Date()) {
  const key = parisDateKey(date);
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, 12, 0, 0) / 86_400_000);
}

function msUntilNextParisMidnight(now = Date.now()) {
  const key = parisDateKey(new Date(now));
  const [y, m, d] = key.split('-').map(Number);
  const todayMidnight = zonedTimeToUtc(y, m, d, 0, 0, 0);
  const nextKey = parisDateKey(new Date(todayMidnight + 36 * 60 * 60 * 1000));
  const [ny, nm, nd] = nextKey.split('-').map(Number);
  let next = zonedTimeToUtc(ny, nm, nd, 0, 0, 0);
  if (next <= now) {
    const laterKey = parisDateKey(new Date(next + 36 * 60 * 60 * 1000));
    const [ly, lm, ld] = laterKey.split('-').map(Number);
    next = zonedTimeToUtc(ly, lm, ld, 0, 0, 0);
  }
  return Math.max(1_000, next - now);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  const arr = items.slice();
  const rand = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function loadStatusList() {
  try {
    if (!fs.existsSync(STATUSES_FILE)) {
      log('warn: statuses.json missing');
      return [];
    }
    const doc = JSON.parse(fs.readFileSync(STATUSES_FILE, 'utf8'));
    const list = Array.isArray(doc.statuses) ? doc.statuses : [];
    return list
      .filter((s) => {
        if (!s || !PRESENCE_TYPES.has(s.type)) return false;
        const text = String(s.text || '').trim();
        return text.length > 0 && text.length <= 120;
      })
      .map((s) => ({ type: s.type, text: String(s.text).trim() }));
  } catch (err) {
    log(`warn: failed to read statuses.json: ${err.message}`);
    return [];
  }
}

function loadStatusOverride() {
  try {
    if (!fs.existsSync(STATUS_OVERRIDE_FILE)) return null;
    const doc = JSON.parse(fs.readFileSync(STATUS_OVERRIDE_FILE, 'utf8'));
    if (!doc || !String(doc.text || '').trim()) return null;
    const text = String(doc.text).trim().slice(0, 120);
    const type = PRESENCE_TYPES.has(doc.type) ? doc.type : 'Custom';
    if (doc.until) {
      const until = Date.parse(doc.until);
      if (!Number.isFinite(until)) {
        log(`warn: status_override.json has invalid until=${doc.until}`);
        return null;
      }
      if (until <= Date.now()) return null;
    }
    return { type, text, until: doc.until || null, override: true };
  } catch (err) {
    log(`warn: failed to read status_override.json: ${err.message}`);
    return null;
  }
}

function pickDailyEntry(now = new Date()) {
  const override = loadStatusOverride();
  if (override) return { ...override, index: null, total: null, date: parisDateKey(now) };
  const list = loadStatusList();
  if (!list.length) return null;
  const cycle = seededShuffle(list, PRESENCE_SEED);
  const dayNum = parisDayNumber(now);
  const index = ((dayNum % cycle.length) + cycle.length) % cycle.length;
  return { ...cycle[index], index, total: cycle.length, date: parisDateKey(now), override: false };
}

function pickOnlineStatus(dayNum) {
  // 8/10 online, 1/10 dnd, 1/10 idle — mostly online, sometimes dnd
  const bucket = ((dayNum * 1103515245 + 12345) >>> 0) % 10;
  if (bucket === 7) return 'dnd';
  if (bucket === 3) return 'idle';
  return 'online';
}

function toActivity(entry) {
  const type = ActivityType[entry.type] ?? ActivityType.Custom;
  if (type === ActivityType.Custom) {
    return { name: 'Custom Status', type, state: entry.text };
  }
  return { name: entry.text, type };
}

function describeActivity(activity) {
  if (!activity) return 'none';
  const typeName = ActivityType[activity.type] || String(activity.type);
  const text = activity.type === ActivityType.Custom ? (activity.state || activity.name) : activity.name;
  return `${typeName}:${text}`;
}

function applyDailyPresence(reason) {
  if (!client.user) return;
  const picked = pickDailyEntry();
  if (!picked) {
    log(`presence skip reason=${reason}: no statuses`);
    return;
  }
  const status = pickOnlineStatus(parisDayNumber());
  const activity = toActivity(picked);
  try {
    client.user.setPresence({ activities: [activity], status });
    const gw = client.user.presence?.activities?.[0];
    const label = PRESENCE_LABELS[picked.type] || picked.type;
    const src = picked.override
      ? `override until=${picked.until || 'until-removed'}`
      : `day=${picked.date} index=${picked.index + 1}/${picked.total}`;
    log(
      `presence set reason=${reason} ${src} status=${status} type=${picked.type} label="${label}" text=${JSON.stringify(picked.text)} gateway=${describeActivity(gw)}`,
    );
  } catch (err) {
    log(`presence error reason=${reason}: ${err.message}`);
  }
}

function armPresenceMidnight() {
  if (presenceTimer) clearTimeout(presenceTimer);
  const delay = msUntilNextParisMidnight();
  const when = new Date(Date.now() + delay);
  presenceTimer = setTimeout(() => {
    try {
      applyDailyPresence('midnight');
    } catch (err) {
      log(`presence midnight error: ${err.message}`);
    }
    armPresenceMidnight();
  }, delay);
  if (typeof presenceTimer.unref === 'function') presenceTimer.unref();
  log(`presence armed next_midnight=${parisDateKey(when)}T00:00:00 ${PRESENCE_TZ} in=${Math.round(delay / 1000)}s`);
}

function stopPresenceRotation() {
  if (presenceTimer) {
    clearTimeout(presenceTimer);
    presenceTimer = null;
  }
}

function agentsChannelSummary(c) {
  const out = [];
  for (const gid of allowedGuilds) {
    const g = c.guilds.cache.get(gid);
    if (!g) continue;
    for (const ch of g.channels.cache.values()) {
      if (ch.id === AGENTS_CATEGORY_ID || channelInAgents(g, ch.id)) out.push(`${ch.name}(${ch.id})`);
    }
  }
  return out.join(', ') || 'none';
}

function onReady(c) {
  if (client._bridgeReadyLogged) return;
  client._bridgeReadyLogged = true;
  for (const g of c.guilds.cache.values()) {
    g.members.fetch({ withPresences: true }).then((m) => log(`members fetched guild=${g.id} n=${m.size}`)).catch((e) => log(`members fetch failed guild=${g.id}: ${e.message}`));
  }
  const user = c.user;
  const guildList = [...c.guilds.cache.values()]
    .map((g) => `${g.name}(${g.id})`)
    .join(', ') || '(none)';
  log(
    `ready logged in as ${user.tag} id=${user.id} app=${BOT_APP_ID} guilds=[${guildList}] allowed=[${[...allowedGuilds].join(',')}] dms=${ALLOW_DMS ? 'on' : 'off'} agents_category=${AGENTS_CATEGORY_ID} agents_channels=[${agentsChannelSummary(c)}] plans=buttons daily_roast=${ROAST_ENABLED ? 'on' : 'off'} aliases=[${botAliases.join(', ')}] webhook=${webhookConfigured() ? 'configured' : 'missing'} voice=${AUTO_VOICE ? 'on' : 'off'}`,
  );
  startAutoVoiceResync();
  try {
    syncAutoVoice('ready');
  } catch (err) {
    log(`auto-voice ready error: ${err.message}`);
  }
  try {
    applyDailyPresence('ready');
  } catch (err) {
    log(`presence ready error: ${err.message}`);
  }
  armPresenceMidnight();
  startDailyRoast();
  registerSlashCommands(c);
}

async function registerSlashCommands(c) {
  try {
    await slash.registerGuildCommands({
      applicationCommands: c.application.commands,
      guildIds: [...allowedGuilds],
      commands: [restart.commandPayload(), slash.classementPayload(), slash.fichePayload()],
      log,
    });
  } catch (err) {
    log(`slash command registration failed: ${err.message}`);
  }
}

client.once('clientReady', onReady);

client.on('error', (err) => {
  log(`client error: ${err.message}`);
});

client.on('shardError', (err) => {
  log(`shard error: ${err.message}`);
});

client.on('shardReady', (id) => {
  log(`shard ready id=${id}`);
  autoVoiceAsserted.clear();
  startAutoVoiceResync();
  try {
    syncAutoVoice('shardReady');
  } catch (err) {
    log(`auto-voice shardReady error: ${err.message}`);
  }
  try {
    applyDailyPresence('shardReady');
  } catch (err) {
    log(`presence shardReady error: ${err.message}`);
  }
});

client.on('shardResume', (id) => {
  log(`shard resume id=${id}`);
  autoVoiceAsserted.clear();
  try {
    syncAutoVoice('shardResume');
  } catch (err) {
    log(`auto-voice shardResume error: ${err.message}`);
  }
  try {
    applyDailyPresence('shardResume');
  } catch (err) {
    log(`presence shardResume error: ${err.message}`);
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!AUTO_VOICE) return;
  const guildId = newState.guild?.id || oldState.guild?.id;
  if (!guildId || !allowedGuilds.has(guildId)) return;
  scheduleAutoVoice('voiceStateUpdate');
});

client.on('messageCreate', async (message) => {
  try {
    if (client.user && message.author.id === client.user.id) {
      stopTypingLoop(message.channelId);
      // Daily roast pool: humans the bot replied to in an AGENTS channel.
      const ru = message.mentions?.repliedUser;
      if (ru && !ru.bot && message.guildId && channelInAgents(message.guild, message.channelId)) {
        try { roast.recordContact(ru.id, message.channelId); } catch (err) { log(`warn: recordContact failed: ${err.message}`); }
      }
      // Light count of our own guild messages for /classement. Never trigger
      // on ourselves (return below): no webhook, no throwback, no self-reply.
      if (message.guildId && USERMEM_ENABLED && allowedGuilds.has(message.guildId) && !message.system) {
        userMem.recordMessage(message, { selfId: client.user.id }).catch((err) => log(`warn: usermem self append failed: ${err.message}`));
      }
      return;
    }
    // Never react to our own output: own user id (above), or anything sent
    // through our application (interaction responses / app webhooks).
    if (client.user && (message.applicationId === client.user.id || message.webhookId === client.user.id)) return;
    if (message.system) return;
    const authorIsBot = Boolean(message.author?.bot);
    // Creator exception (AGENTS.md): other bots trigger with the same rules as
    // humans, capped by the anti-loop guard (consecutive bot replies).
    // A human message in the channel resets the streak.
    if (!authorIsBot) botLoopGuard.noteHuman(message.channelId);

    const isDm = !message.guildId;

    if (isDm) {
      if (!ALLOW_DMS) return;
      if (message.channel?.partial) {
        try {
          await message.channel.fetch();
        } catch (err) {
          log(`warn: failed to fetch DM channel ${message.channelId}: ${err.message}`);
          return;
        }
      }
      if (!(await userSharesAllowedGuild(message.author.id))) {
        log(`skip dm user=${message.author.id} channel=${message.channelId} reason=not in allowed guild`);
        return;
      }
    } else if (!allowedGuilds.has(message.guildId)) {
      return;
    }

    // Per-user memory: log every guild message (never DMs). Fire-and-forget.
    if (!isDm && USERMEM_ENABLED) {
      userMem.recordMessage(message, { selfId: client.user?.id }).catch((err) => log(`warn: usermem append failed: ${err.message}`));
    }

    // Once the consecutive bot-reply cap is hit, ignore bot authors silently
    // (no webhook, no reaction) until a human posts or the idle timer elapses.
    if (authorIsBot && botLoopGuard.isCapped(message.channelId)) {
      log(`skip bot-loop trigger=capped bot=${message.author.id} username=${message.author.username} channel=${message.channelId} message=${message.id} reason=max ${botLoopGuard.max} consecutive bot replies`);
      return;
    }

    // Discord Agent Rules (AGENTS.md), deterministic:
    //  - inside the AGENTS category: every trigger;
    //  - elsewhere in the guild: an explicit @mention token in the content, or a
    //    reply to one of the bot's own messages (creator-approved exception).
    const inAgents = !isDm && channelInAgents(message.guild, message.channelId);
    const botRoleIds = [];
    const botRole = message.guild?.members?.me?.roles?.botRole;
    if (botRole) botRoleIds.push(botRole.id);
    for (const role of message.mentions.roles.values()) if (role.tags?.botId === client.user?.id) botRoleIds.push(role.id);
    const explicitMention = !isDm && hasExplicitMentionToken(message, botRoleIds);
    const mentioned = isBotMentioned(message, client);
    const named = hasBotAlias(message.content || '');
    const replyToBot = await isReplyToBot(message, client);
    const keyword = hasKeyword(message.content || '');

    const decision = scope.decideTrigger({
      isDm, inAgents, explicitMention, mentioned, named, replyToBot, keyword,
    });
    const trigger = decision.trigger;
    if (!trigger) {
      if (decision.skipped) {
        log(`skip out-of-scope trigger=${decision.skipped} user=${message.author.id} channel=${message.channelId} message=${message.id} reason=outside AGENTS without explicit @mention`);
      }
      return;
    }

    if (authorIsBot) {
      const g = botLoopGuard.check(message.channelId, message.author.id);
      if (!g.ok) {
        log(`skip bot-loop trigger=${trigger} bot=${message.author.id} username=${message.author.username} channel=${message.channelId} message=${message.id} reason=${g.reason}`);
        return;
      }
    }

    const limit = checkRateLimits(message.author.id);
    if (!limit.ok) {
      log(
        `skip trigger=${trigger} user=${message.author.id} channel=${message.channelId} message=${message.id} reason=${limit.reason}`,
      );
      return;
    }

    markTriggered(message.author.id);
    if (authorIsBot) botLoopGuard.record(message.channelId, message.author.id);
    recordTrigger(message, trigger);
    if (inAgents && !authorIsBot && message.author.id !== CREATOR_USER_ID) {
      try { roast.recordContact(message.author.id, message.channelId); } catch (err) { log(`warn: recordContact failed: ${err.message}`); }
    }
    log(
      `trigger=${trigger} user=${message.author.id} username=${message.author.username} channel=${message.channelId} message=${message.id} guild=${message.guildId || 'dm'} is_dm=${isDm} in_agents=${inAgents} author_bot=${authorIsBot}`,
    );

    if (!webhookConfigured()) {
      log('skip webhook POST: ROUTINE_WEBHOOK_URL and/or ROUTINE_WEBHOOK_KEY missing');
      return;
    }

    startTypingLoop(message.channel);

    const referenced = await getReferenced(message);
    // Photos only when the message is aimed at the bot (mention, alias, reply,
    // or DM). Never for other bots, never for ambient keyword triggers.
    const includeImages = images.shouldAttachImages({
      authorIsBot, mentioned, named, replyToBot, isDm,
    });
    if (referenced && !includeImages) delete referenced.images;
    const payload = {
      guild_id: message.guildId || null,
      channel_id: message.channelId,
      message_id: message.id,
      is_dm: isDm,
      in_agents: inAgents,
      author: {
        id: message.author.id,
        username: message.author.username,
        display_name: authorName(message),
        bot: authorIsBot,
      },
      content: truncate(resolveContent(message), 2000),
      recent: await recentMessages(message, RECENT_LIMIT),
      referenced,
      mentions: compactMentions(message, client.user?.id),
      guild: compactGuildInfo(message.guildId || [...allowedGuilds][0]),
      memory: loadPrefetchedMemory(message, client.user?.id),
      users: loadUserContext(message, client.user?.id, referenced, trigger),
      skills: loadActiveSkills(),
      trigger,
    };
    if (includeImages) images.withImages(payload, message, true);
    shrinkPayload(payload);

    log(
      `payload bytes=${JSON.stringify(payload).length} recent=${payload.recent.length} skills=${payload.skills.length} mentioned_memories=${payload.memory.mentioned.length} user_ctx=${payload.users ? `${payload.users.author.recent.length}+${payload.users.others.length}` : 'off'} images=${(payload.images || []).length}+${(payload.referenced && payload.referenced.images || []).length} guild_roles=${payload.guild?.roles?.length ?? 0} guild_channels=${payload.guild?.channels?.length ?? 0}`,
    );

    await postWebhook(payload);
  } catch (err) {
    log(`messageCreate handler error: ${err.message}`);
  }
});


// ---- daily roast (once per Paris day, random time 18:00-22:00, AGENTS only) ----
const ROAST_ENABLED = config.DAILY_ROAST;
const ROAST_START_H = 18;
const ROAST_END_H = 22;
let roastTimer = null;
let roastBusy = false;

function roastWindow(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return { start: zonedTimeToUtc(y, m, d, ROAST_START_H, 0, 0), end: zonedTimeToUtc(y, m, d, ROAST_END_H, 0, 0) };
}

async function dailyRoastTick() {
  if (!ROAST_ENABLED || roastBusy || !client.isReady()) return;
  roastBusy = true;
  try {
    const today = parisDateKey();
    let st = roast.loadRoastState();
    if (st.date !== today) {
      const w = roastWindow(today);
      const at = w.start + Math.floor(Math.random() * (w.end - w.start));
      st = { ...st, date: today, scheduled_at: at, window_end: w.end, status: 'scheduled' };
      roast.saveRoastState(st);
      log(`daily-roast scheduled date=${today} at=${new Date(at).toLocaleTimeString('fr-FR', { timeZone: PRESENCE_TZ })} Europe/Paris`);
    }
    if (st.status !== 'scheduled' || Date.now() < st.scheduled_at) return;
    if (Date.now() > st.window_end) {
      roast.saveRoastState({ ...st, status: 'skipped_missed_window' });
      log(`daily-roast skipped date=${today} reason=bridge down past the ${ROAST_END_H}:00 window`);
      return;
    }
    // Claim before firing so a crash/restart can never double-fire.
    roast.saveRoastState({ ...st, status: 'firing', fired_at: Date.now() });
    if (!webhookConfigured()) throw new Error('webhook not configured');
    const guildInfo = compactGuildInfo([...allowedGuilds][0]);
    const payload = await roast.buildRoastPayload({ guildInfo });
    if (!payload) {
      roast.saveRoastState({ ...roast.loadRoastState(), status: 'skipped_no_target' });
      log(`daily-roast skipped date=${today} reason=no eligible target`);
      return;
    }
    const ok = await postWebhook(shrinkPayload(payload));
    const cur = roast.loadRoastState();
    roast.saveRoastState({ ...cur, status: ok ? 'done' : 'failed', done_date: ok ? today : cur.done_date, target_id: payload.target.id, channel_id: payload.channel_id });
    if (ok) roast.recordRoast({ date: today, user_id: payload.target.id, channel_id: payload.channel_id, at: Date.now() });
    log(`daily-roast ${ok ? 'fired' : 'FAILED'} date=${today} target=${payload.target.id} (${payload.target.username}) channel=${payload.channel_id} target_messages=${payload.target_messages.length}`);
  } catch (err) {
    try { roast.saveRoastState({ ...roast.loadRoastState(), status: 'failed', error: err.message }); } catch { /* ignore */ }
    log(`daily-roast error: ${err.message}`);
  } finally {
    roastBusy = false;
  }
}

function startDailyRoast() {
  if (!ROAST_ENABLED || roastTimer) return;
  roast.seedContacts()
    .then((r) => { if (r.seeded) log(`daily-roast contacts seeded n=${Object.keys(r.users).length}`); })
    .catch((err) => log(`daily-roast seed failed: ${err.message}`));
  roastTimer = setInterval(() => { dailyRoastTick(); }, 60_000);
  setTimeout(() => { dailyRoastTick(); }, 15_000);
}

// ---- plan confirmation buttons (Discord Agent Rules, deterministic) ----
// The AI never executes mutating actions: act.sh posts a plan with
// Confirmer/Annuler buttons; only here, on a click by the original requester,
// does the bridge re-verify permissions and execute exactly the stored plan.
const PLAN_BUTTON_RE = /^plan:(confirm|cancel):([a-f0-9]{6,16})$/;
let modLib = null;
function mod() {
  if (!modLib) modLib = require('./mod');
  return modLib;
}

function slashAuthor(interaction) {
  return {
    id: interaction.user.id,
    username: interaction.user.username,
    display_name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    bot: Boolean(interaction.user.bot),
  };
}

function slashAllowed(interaction) {
  if (!interaction.guildId) return false;
  return allowedGuilds.has(interaction.guildId);
}

async function handleClassementCommand(interaction) {
  if (!slashAllowed(interaction)) {
    await interaction.reply({ content: 'Serveur non autorisé.', flags: 64 }).catch(() => {});
    return;
  }
  const userId = interaction.user.id;
  const now = Date.now();
  const cd = slash.checkCooldown(slash.CLASSEMENT, userId, slash.CLASSEMENT_COOLDOWN_MS, now);
  if (!cd.ok) {
    await interaction.reply({ content: slash.COOLDOWN_CLASSEMENT, flags: 64 }).catch(() => {});
    return;
  }
  slash.markCooldown(slash.CLASSEMENT, userId, now);
  const period = interaction.options.getString('periode') || '7j';
  const channel = interaction.options.getChannel('salon');
  const board = userMem.leaderboard({
    period,
    channelId: channel?.id || null,
    limit: 10,
    now,
    selfId: client.user?.id,
  });
  const embed = slash.buildClassementEmbed({
    period: board.period,
    channelName: channel?.name || null,
    rows: board.rows,
  });
  log(`slash /classement user=${userId} period=${board.period} channel=${channel?.id || 'all'} rows=${board.rows.length}`);
  await interaction.reply({
    embeds: [embed],
    allowedMentions: { parse: [] },
  }).catch((err) => log(`slash /classement reply failed: ${err.message}`));
}

async function handleFicheCommand(interaction) {
  if (!slashAllowed(interaction)) {
    await interaction.reply({ content: 'Serveur non autorisé.', flags: 64 }).catch(() => {});
    return;
  }
  const userId = interaction.user.id;
  const now = Date.now();
  const cd = slash.checkCooldown(slash.FICHE, userId, slash.FICHE_COOLDOWN_MS, now);
  if (!cd.ok) {
    await interaction.reply({ content: slash.COOLDOWN_FICHE, flags: 64 }).catch(() => {});
    return;
  }
  const hourly = slash.checkFicheHourly(now);
  const targetUser = interaction.options.getUser('membre');
  const targetMember = interaction.options.getMember('membre');
  const target = targetUser ? {
    id: targetUser.id,
    username: targetUser.username,
    display_name: targetMember?.displayName || targetUser.globalName || targetUser.username,
    bot: Boolean(targetUser.bot),
  } : null;
  const decision = slash.decideFiche({
    target,
    selfId: client.user?.id,
    isOptedOut: (id) => userMem.isOptedOut(id),
    context: (id) => userMem.contextFor(id, { limit: USERMEM_AUTHOR_LIMIT, max: 220, role: 'target' }),
  });
  slash.markCooldown(slash.FICHE, userId, now);
  if (!decision.ok) {
    log(`slash /fiche local user=${userId} target=${target && target.id} reason=${decision.reason}`);
    await interaction.reply({ content: decision.reply, allowedMentions: { parse: [] } }).catch(() => {});
    return;
  }
  if (!hourly.ok) {
    await interaction.reply({ content: slash.HOURLY_FICHE, flags: 64 }).catch(() => {});
    return;
  }
  if (!webhookConfigured()) {
    await interaction.reply({ content: 'Le cerveau est hors-ligne. Réessaie plus tard.', flags: 64 }).catch(() => {});
    return;
  }

  await interaction.deferReply();
  slash.markFicheHourly(now);
  const applicationId = interaction.applicationId || client.application?.id || BOT_APP_ID;
  slash.savePending({
    id: interaction.id,
    applicationId,
    token: interaction.token,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    userId,
    now,
  });
  const inAgents = channelInAgents(interaction.guild, interaction.channelId);
  const payload = slash.buildFichePayload({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    inAgents,
    requester: slashAuthor(interaction),
    target,
    targetContext: decision.context,
    interactionId: interaction.id,
  });
  if (slash.payloadContainsSecret(payload, interaction.token)) {
    log('slash /fiche aborted: payload would have included the interaction token');
    try {
      await slash.followUpFiche({ applicationId, token: interaction.token, content: 'J\'ai merdé, réessaie.' });
    } catch (err) {
      log(`slash /fiche token-guard follow-up failed: ${err.message}`);
    }
    slash.deletePending(interaction.id);
    return;
  }
  log(`slash /fiche user=${userId} target=${target.id} interaction=${interaction.id} in_agents=${inAgents}`);
  const ok = await postWebhook(shrinkPayload(payload) || payload);
  if (!ok) {
    log(`slash /fiche webhook failed interaction=${interaction.id}`);
    try {
      await slash.followUpFiche({ applicationId, token: interaction.token, content: 'J\'ai merdé, réessaie.' });
    } catch (err) {
      log(`slash /fiche failure follow-up failed: ${err.message}`);
    }
    slash.deletePending(interaction.id);
  }
}

async function handleRestartCommand(interaction) {
  const userId = interaction.user?.id;
  const decision = restart.decideRestart({
    userId,
    creatorId: CREATOR_USER_ID,
    now: Date.now(),
    lastAt: lastRestartAt,
  });
  // Never trust a username: only interaction.user.id is checked.
  if (!decision.ok) {
    log(`slash /restart refused user=${userId} reason=${decision.reason}`);
    await interaction.reply({ content: decision.reply, flags: 64 }).catch(() => {});
    return;
  }
  lastRestartAt = Date.now();
  await interaction.reply({ content: decision.reply, flags: 64 }).catch((err) => {
    log(`slash /restart reply failed: ${err.message}`);
  });
  setTimeout(() => process.exit(1), 3000).unref();
  await restart.performRestart({
    userId,
    log,
    destroy: () => client.destroy(),
    exit: (code) => process.exit(code),
  });
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      if (name === restart.COMMAND_NAME) {
        await handleRestartCommand(interaction);
        return;
      }
      if (name === slash.CLASSEMENT) {
        await handleClassementCommand(interaction);
        return;
      }
      if (name === slash.FICHE) {
        await handleFicheCommand(interaction);
        return;
      }
    }
    if (!interaction.isButton()) return;
    const m = PLAN_BUTTON_RE.exec(interaction.customId || '');
    if (!m) return;
    const [, decision, planId] = m;
    const clicker = interaction.user.id;
    const inAllowed = interaction.guildId ? allowedGuilds.has(interaction.guildId) : true;
    if (!inAllowed) {
      await interaction.reply({ content: 'Serveur non autorisé.', flags: 64 }).catch(() => {});
      return;
    }
    const plan = mod().getPlan(planId);
    if (!plan) {
      await interaction.reply({ content: 'Plan introuvable.', flags: 64 }).catch(() => {});
      return;
    }
    if (plan.requester_id !== clicker) {
      log(`plan click refused plan=${planId} clicker=${clicker} reason=not requester`);
      fs.appendFileSync(config.MOD_LOG, `${localTs().slice(0, 19)} plan click refused ${planId} clicker=${clicker} action=${decision} not the requester\n`);
      await interaction.reply({ content: 'Pas touche : seul le demandeur de ce plan peut le confirmer ou l\'annuler.', flags: 64 }).catch(() => {});
      return;
    }
    await interaction.deferUpdate();
    log(`plan click plan=${planId} decision=${decision} clicker=${clicker}`);
    const res = decision === 'confirm'
      ? await mod().executePlan(planId, clicker, interaction.message?.id)
      : await mod().cancelPlan(planId, clicker, interaction.message?.id);
    if (!res.ok && res.ephemeral) {
      await interaction.followUp({ content: res.ephemeral, flags: 64 }).catch(() => {});
    }
    log(`plan result plan=${planId} decision=${decision} status=${res.plan?.status || 'n/a'} ok=${res.ok}`);
  } catch (err) {
    log(`interactionCreate error: ${err.message}`);
    try {
      const msg = interaction.isChatInputCommand?.() ? 'Erreur pendant la commande.' : 'Erreur pendant le traitement du plan.';
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: msg, flags: 64 });
      else await interaction.reply({ content: msg, flags: 64 });
    } catch { /* ignore */ }
  }
});

// ---- health watchdog (in-process) + heartbeat file for the external one ----
// After a box suspend/VM fork the websocket is dead; wall-clock jump and
// gateway silence must force a restart on the first strike. A frozen box
// itself cannot be prevented in-process: nothing runs until it thaws.
const HEARTBEAT_FILE = path.join(DATA_DIR, 'heartbeat');
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 5_000);
const WATCHDOG_ACTIVITY_MAX_MS = Number(process.env.WATCHDOG_ACTIVITY_MAX_MS || 90_000);
const WATCHDOG_CLOCK_JUMP_MS = Number(process.env.WATCHDOG_CLOCK_JUMP_MS || 30_000);
const WATCHDOG_PING_MAX_MS = 15_000;
const WATCHDOG_STARTUP_GRACE_MS = Number(process.env.WATCHDOG_STARTUP_GRACE_MS || 120_000);
const WATCHDOG_FAILS_TO_EXIT = Number(process.env.WATCHDOG_FAILS_TO_EXIT || 1);
const WATCHDOG_BADPING_TO_EXIT = 4;
const processStartedAt = Date.now();
let lastDispatchAt = 0;
let lastHeartbeatAckAt = 0;
let lastWatchdogTickAt = Date.now();
let watchdogFails = 0;
let watchdogBadPing = 0;
let watchdogRestarting = false;

client.on('raw', () => { lastDispatchAt = Date.now(); });
client.on('debug', (msg) => {
  const m = String(msg);
  if (/heartbeat acknowledged/i.test(m)) lastHeartbeatAckAt = Date.now();
  if (/zombie|resuming session|close code|invalid session|reconnect/i.test(m)) {
    log(`gateway debug: ${m.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
});
client.on('shardDisconnect', (ev, id) => log(`shard disconnect id=${id} code=${ev?.code}`));
client.on('shardReconnecting', (id) => log(`shard reconnecting id=${id}`));
client.on('invalidated', () => { log('session invalidated, exiting for restart'); process.exit(1); });

function writeHeartbeat(h, gw) {
  try {
    const ready = client.isReady() ? 1 : 0;
    const ping = Number.isFinite(h.ping) ? h.ping : -1;
    fs.writeFileSync(
      HEARTBEAT_FILE,
      `${new Date().toISOString()} ping=${ping} idle_ms=${h.idle} pid=${process.pid} ready=${ready} gw=${gw}\n`,
    );
  } catch (err) {
    log(`watchdog warn: heartbeat write failed: ${err.message}`);
  }
}

function forceRestart(reason) {
  if (watchdogRestarting) return;
  watchdogRestarting = true;
  log(`watchdog: forcing restart (${reason})`);
  try { stopAllTypingLoops(); } catch { /* ignore */ }
  try { stopAutoVoice(); } catch { /* ignore */ }
  try { stopPresenceRotation(); } catch { /* ignore */ }
  const exitNow = () => process.exit(1);
  try {
    const destroyed = client.destroy();
    if (destroyed && typeof destroyed.then === 'function') {
      destroyed.catch((err) => log(`watchdog: destroy failed: ${err.message}`)).finally(exitNow);
    } else {
      exitNow();
    }
  } catch (err) {
    log(`watchdog: destroy failed: ${err.message}`);
    exitNow();
  }
  setTimeout(exitNow, 3000).unref();
}

function gatewayHealth() {
  const now = Date.now();
  const shards = [...client.ws.shards.values()];
  for (const sh of shards) {
    if (sh.lastPingTimestamp > lastHeartbeatAckAt) lastHeartbeatAckAt = sh.lastPingTimestamp;
  }
  const problems = [];
  const allReady = shards.length > 0 && shards.every((sh) => sh.status === 0);
  if (client.ws.status !== 0 || !allReady) {
    problems.push(`status=${client.ws.status} shards=${shards.map((sh) => sh.status).join(',') || 'none'}`);
  }
  const lastActivity = Math.max(lastDispatchAt, lastHeartbeatAckAt);
  const idle = lastActivity ? now - lastActivity : now - processStartedAt;
  if (idle > WATCHDOG_ACTIVITY_MAX_MS) problems.push(`no gateway ack/dispatch for ${Math.round(idle / 1000)}s`);
  const ping = client.ws.ping;
  // -1/NaN = no sample yet (Discord heartbeat interval is often ~41s). Only a
  // real high ping is a ping failure; silence is caught by idle/status.
  const pingBad = Number.isFinite(ping) && ping >= 0 && ping >= WATCHDOG_PING_MAX_MS;
  return { problems, ping, pingBad, idle };
}

function watchdogTick() {
  const now = Date.now();
  const drifted = now - lastWatchdogTickAt;
  lastWatchdogTickAt = now;
  // setInterval uses a monotonic clock; after a VM suspend/fork, wall time
  // jumps while the timer may only fire once the box thaws. The websocket
  // is already dead in that case, so reconnect immediately.
  if (drifted > WATCHDOG_CLOCK_JUMP_MS) {
    writeHeartbeat({ ping: client.ws?.ping, idle: drifted }, 'bad');
    log(`watchdog clock jump: ${Math.round(drifted / 1000)}s elapsed (expected ${Math.round(WATCHDOG_INTERVAL_MS / 1000)}s)`);
    forceRestart(`wall-clock jump of ${Math.round(drifted / 1000)}s`);
    return;
  }
  if (now - processStartedAt < WATCHDOG_STARTUP_GRACE_MS && !client.isReady()) return;
  let h;
  try {
    h = gatewayHealth();
  } catch (err) {
    h = { problems: [`health check threw: ${err.message}`], ping: NaN, pingBad: true, idle: -1 };
  }
  watchdogBadPing = h.pingBad ? watchdogBadPing + 1 : 0;
  if (watchdogBadPing >= WATCHDOG_BADPING_TO_EXIT) h.problems.push(`ping=${h.ping} bad for ${watchdogBadPing} checks`);
  if (h.problems.length) {
    watchdogFails += 1;
    writeHeartbeat(h, 'bad');
    log(`watchdog unhealthy (${watchdogFails}/${WATCHDOG_FAILS_TO_EXIT}): ${h.problems.join('; ')}`);
    if (watchdogFails >= WATCHDOG_FAILS_TO_EXIT) {
      forceRestart(h.problems.join('; '));
    }
    return;
  }
  watchdogFails = 0;
  writeHeartbeat(h, 'ok');
}
setInterval(watchdogTick, WATCHDOG_INTERVAL_MS);

process.on('unhandledRejection', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  log(`unhandledRejection (exiting for restart): ${msg}`);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  log(`uncaughtException (exiting for restart): ${msg}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('received SIGINT, shutting down');
  stopAllTypingLoops();
  stopAutoVoice();
  stopPresenceRotation();
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('received SIGTERM, shutting down');
  stopAllTypingLoops();
  stopAutoVoice();
  stopPresenceRotation();
  client.destroy();
  process.exit(0);
});

// Optional /act HTTP API (Fly). Off unless ACT_HTTP is explicitly on.
if (!['0', 'false', 'no', 'off', ''].includes(String(process.env.ACT_HTTP ?? 'off').trim().toLowerCase())) {
  try {
    require('./act_http').start({ log, getReady: () => client.isReady() });
  } catch (err) {
    log(`act-http failed to start: ${err.message}`);
  }
}

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
  log(`login failed: ${err.message}`);
  process.exit(1);
});
