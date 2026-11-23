'use strict';

/**
 * Deterministic enforcement of the server's Discord Agent Rules (see AGENTS.md).
 *  - AGENTS category scope (channel, thread parent, or the category itself).
 *  - Explicit @ mention detection (content token, not a reply ping).
 *  - Trigger decision (pure function, unit-testable).
 *  - DM rule: users the bot has interacted with (data/interactions.json).
 *  - Unsolicited-message guard for the side scripts (send/embed/reply).
 * DISCORD_BOT_TOKEN is read from the environment only and never logged.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const AGENTS_CATEGORY_ID = config.AGENTS_CATEGORY_ID;
const BOT_ID = config.BOT_APP_ID;
const TRIGGERS_FILE = config.TRIGGERS_FILE;
const INTERACTIONS_FILE = config.INTERACTIONS_FILE;
const THREAD_TYPES = new Set([10, 11, 12]);
const DM_TYPES = new Set([1, 3]);
const SOLICITED_WINDOW_MS = 15 * 60 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

/** Simple cross-process lock (O_EXCL lock file, stale after 10 s). */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.unlinkSync(lock); continue; }
      } catch { /* raced */ }
      if (Date.now() - start > 5_000) throw new Error(`lock timeout on ${path.basename(file)}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
}

/**
 * Pure scope check. `lookup(id)` returns { id, type, parent_id } or null.
 * In AGENTS = the category itself, a channel whose parent is the category,
 * or a thread whose parent channel is in the category.
 */
function isInAgents(channelId, lookup) {
  if (!channelId) return false;
  if (channelId === AGENTS_CATEGORY_ID) return true;
  const ch = lookup(channelId);
  if (!ch) return false;
  if (ch.parent_id === AGENTS_CATEGORY_ID) return true;
  if (THREAD_TYPES.has(ch.type) && ch.parent_id) {
    if (ch.parent_id === AGENTS_CATEGORY_ID) return true;
    const parent = lookup(ch.parent_id);
    return Boolean(parent && parent.parent_id === AGENTS_CATEGORY_ID);
  }
  return false;
}

/** Explicit @ mention = the mention token is literally in the content. */
function hasExplicitMention(content, botId = BOT_ID, botRoleIds = []) {
  const s = String(content || '');
  if (new RegExp(`<@!?${botId}>`).test(s)) return true;
  for (const rid of botRoleIds) if (rid && s.includes(`<@&${rid}>`)) return true;
  return false;
}

/**
 * Pure trigger decision.
 * flags: { isDm, inAgents, explicitMention, mentioned, named, replyToBot, keyword }
 * Other bots follow the SAME rules as humans (creator exception, AGENTS.md);
 * the bot's own messages are filtered before this in bridge.js and bot loops
 * are capped by BotLoopGuard.
 * Returns { trigger|null, skipped|null } where skipped names the trigger a
 * message would have had in AGENTS but which is out of scope here.
 */
function decideTrigger(f) {
  if (f.isDm) return { trigger: 'dm', skipped: null };
  if (f.inAgents) {
    if (f.mentioned || f.explicitMention) return { trigger: 'mention', skipped: null };
    if (f.named) return { trigger: 'name', skipped: null };
    if (f.replyToBot) return { trigger: 'reply_to_bot', skipped: null };
    if (f.keyword) return { trigger: 'keyword', skipped: null };
    return { trigger: null, skipped: null };
  }
  if (f.explicitMention) return { trigger: 'mention', skipped: null };
  // Creator-approved exception (AGENTS.md): replies to the bot's own messages
  // trigger in every channel. Names/aliases/keyword stay AGENTS-only.
  if (f.replyToBot) return { trigger: 'reply_to_bot', skipped: null };
  const skipped = f.mentioned ? 'mention(no @ token)' : f.named ? 'name' : f.keyword ? 'keyword' : null;
  return { trigger: null, skipped };
}

// ---------- anti-loop guard for bot authors ----------
/**
 * Deterministic cap on bot-to-bot conversations, per channel:
 *  - at most `max` consecutive replies by this bot to bot authors;
 *  - a human (non-bot) message in the channel resets the streak to 0;
 *  - the streak also resets after `idleMs` with no bot-triggered reply
 *    (ignored bot messages while capped do not extend the timer);
 *  - at least `authorCooldownMs` between two triggers from the same bot.
 * Humans are never checked against this guard.
 */
class BotLoopGuard {
  constructor({ maxPerWindow = 5, idleMs, windowMs, authorCooldownMs = 5_000 } = {}) {
    this.max = Math.max(1, Number(maxPerWindow) || 5);
    this.idleMs = Math.max(0, Number(idleMs ?? windowMs ?? 20_000) || 20_000);
    this.cooldown = Math.max(0, Number(authorCooldownMs) || 0);
    this.channels = new Map(); // channelId -> { count, lastReplyAt }
    this.lastByAuthor = new Map(); // botAuthorId -> ts
  }
  _state(channelId, now = Date.now()) {
    const id = String(channelId);
    const st = this.channels.get(id);
    if (!st) return { id, count: 0, lastReplyAt: 0 };
    if (this.idleMs && st.lastReplyAt && now - st.lastReplyAt >= this.idleMs) {
      this.channels.delete(id);
      return { id, count: 0, lastReplyAt: 0 };
    }
    return { id, count: st.count, lastReplyAt: st.lastReplyAt };
  }
  noteHuman(channelId) { this.channels.delete(String(channelId)); }
  isCapped(channelId, now = Date.now()) {
    return this._state(channelId, now).count >= this.max;
  }
  check(channelId, authorId, now = Date.now()) {
    const last = this.lastByAuthor.get(String(authorId)) || 0;
    if (this.cooldown && now - last < this.cooldown) {
      return { ok: false, reason: `bot author cooldown (${this.cooldown}ms)` };
    }
    const st = this._state(channelId, now);
    if (st.count >= this.max) {
      const mins = Math.round(this.idleMs / 60000);
      return { ok: false, reason: `max ${this.max} consecutive bot replies in this channel until a human posts or ${mins} min idle` };
    }
    return { ok: true };
  }
  record(channelId, authorId, now = Date.now()) {
    const st = this._state(channelId, now);
    const next = { count: st.count + 1, lastReplyAt: now };
    this.channels.set(st.id, next);
    this.lastByAuthor.set(String(authorId), now);
    return next;
  }
}

// ---------- DM rule: prior interaction ----------
function loadInteractions() {
  const doc = readJson(INTERACTIONS_FILE, null);
  if (doc && doc.users && typeof doc.users === 'object') return doc;
  // Seed from the trigger history (those users already triggered the bot).
  const seeded = { users: {} };
  for (const t of readJson(TRIGGERS_FILE, { triggers: [] }).triggers || []) {
    if (t && t.author_id) seeded.users[t.author_id] = { first: t.at || Date.now(), last: t.at || Date.now(), kind: `trigger:${t.trigger}` };
  }
  return seeded;
}

function hasInteracted(userId) {
  if (!userId) return false;
  return Boolean(loadInteractions().users[String(userId)]);
}

function recordInteraction(userId, kind) {
  if (!userId || String(userId) === BOT_ID) return;
  withLock(INTERACTIONS_FILE, () => {
    const doc = loadInteractions();
    const id = String(userId);
    const now = Date.now();
    const prev = doc.users[id];
    doc.users[id] = { first: prev?.first || now, last: now, kind: kind || prev?.kind || 'interaction' };
    writeJsonAtomic(INTERACTIONS_FILE, doc);
  });
}

// ---------- REST helpers for side scripts ----------
async function restGetChannel(id) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  const res = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(id)}`, { headers: { Authorization: `Bot ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

async function restInAgents(channelId) {
  const cache = new Map();
  const first = await restGetChannel(channelId);
  if (first) cache.set(first.id, first);
  if (first && THREAD_TYPES.has(first.type) && first.parent_id) {
    const parent = await restGetChannel(first.parent_id);
    if (parent) cache.set(parent.id, parent);
  }
  return { inAgents: isInAgents(String(channelId), (id) => cache.get(id) || null), channel: first };
}

function recentTriggerIn(channelId, maxAgeMs = SOLICITED_WINDOW_MS) {
  const now = Date.now();
  return (readJson(TRIGGERS_FILE, { triggers: [] }).triggers || [])
    .some((t) => t.channel_id === String(channelId) && now - (t.at || 0) <= maxAgeMs);
}

function triggerRecord(messageId) {
  return (readJson(TRIGGERS_FILE, { triggers: [] }).triggers || []).find((t) => t.message_id === String(messageId)) || null;
}

/**
 * Side-script guard: posting in a channel is allowed in AGENTS, in a DM, or
 * where the bot was solicited (a recorded trigger in the last 15 minutes).
 */
async function assertMaySpeakIn(channelId) {
  if (recentTriggerIn(channelId)) return 'recent-trigger';
  const { inAgents, channel } = await restInAgents(channelId);
  if (inAgents) return 'agents';
  if (channel && DM_TYPES.has(channel.type)) {
    const rec = (channel.recipients || [])[0];
    if (rec && hasInteracted(rec.id)) return 'dm-interacted';
    throw new Error('refused: no prior interaction with this DM user (Discord Agent Rules)');
  }
  throw new Error('refused: outside the AGENTS category the bot only speaks where it was @mentioned (Discord Agent Rules)');
}

module.exports = {
  AGENTS_CATEGORY_ID, BOT_ID, INTERACTIONS_FILE, THREAD_TYPES, DM_TYPES,
  readJson, writeJsonAtomic, withLock,
  isInAgents, hasExplicitMention, decideTrigger, BotLoopGuard,
  loadInteractions, hasInteracted, recordInteraction,
  restInAgents, recentTriggerIn, triggerRecord, assertMaySpeakIn,
};
