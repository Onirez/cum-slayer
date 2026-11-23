'use strict';

/**
 * "Roast du jour": once per Paris day the bot roasts one human it has already
 * talked with in an AGENTS channel. Only in AGENTS channels (see AGENTS.md).
 * REST-only so it works from bridge.js and from roast_now.js.
 * Secrets (DISCORD_BOT_TOKEN, ROUTINE_WEBHOOK_URL, ROUTINE_WEBHOOK_KEY) are
 * read from the environment only and never printed.
 */

const fs = require('fs');
const path = require('path');
const scope = require('./scope');

const config = require('./config');
const API = 'https://discord.com/api/v10';
const GUILD_ID = config.GUILD_ID;
const CREATOR_ID = config.CREATOR_ID;
const BOT_ID = config.BOT_APP_ID;
const FALLBACK_CHANNEL_ID = config.FALLBACK_CHANNEL_ID;
const CONTACTS_FILE = config.CONTACTS_FILE;
const ROAST_FILE = config.ROAST_STATE_FILE;
const TRIGGERS_FILE = config.TRIGGERS_FILE;
const MEMORY_DIR = config.MEMORY_DIR;
const SKILLS_FILE = config.SKILLS_FILE;
const AVOID_DAYS = 5;
const TARGET_MSG_LIMIT = 15;

const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s; };

async function rest(p) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) { const j = await res.json().catch(() => ({})); await new Promise((r) => setTimeout(r, Math.min(5000, (j.retry_after || 1) * 1000))); continue; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Discord GET ${p.split('?')[0]} status=${res.status}`);
    return res.json();
  }
  throw new Error('rate limited');
}

// ---------- contacts ----------
function loadContacts() { return scope.readJson(CONTACTS_FILE, { users: {} }); }

/** Record a human the bot talked with in an AGENTS channel. Caller checks scope. */
function recordContact(userId, channelId, at = Date.now()) {
  if (!userId || userId === CREATOR_ID || userId === BOT_ID) return;
  scope.withLock(CONTACTS_FILE, () => {
    const doc = loadContacts();
    doc.users = doc.users || {};
    const prev = doc.users[userId] || { count: 0 };
    doc.users[userId] = {
      last_channel_id: at >= (prev.last_at || 0) ? String(channelId) : prev.last_channel_id,
      last_at: Math.max(at, prev.last_at || 0),
      count: (prev.count || 0) + 1,
    };
    scope.writeJsonAtomic(CONTACTS_FILE, doc);
  });
}

async function agentsChannels() {
  const chs = (await rest(`/guilds/${GUILD_ID}/channels`)) || [];
  const by = new Map(chs.map((c) => [c.id, c]));
  const list = chs.filter((c) => c.id !== scope.AGENTS_CATEGORY_ID && scope.isInAgents(c.id, (id) => by.get(id) || null));
  return { all: chs, by, agents: list, textAgents: list.filter((c) => [0, 5].includes(c.type)) };
}

/** Seed contacts from triggers.json (AGENTS channels resolved over REST, bots filtered). */
async function seedContacts() {
  if (fs.existsSync(CONTACTS_FILE)) return { seeded: false };
  const { by } = await agentsChannels();
  const inAgents = (id) => scope.isInAgents(id, (x) => by.get(x) || null);
  const triggers = scope.readJson(TRIGGERS_FILE, { triggers: [] }).triggers || [];
  const users = {};
  const botCache = new Map();
  for (const t of triggers) {
    if (t.guild_id !== GUILD_ID || !inAgents(t.channel_id)) continue;
    if (!t.author_id || t.author_id === CREATOR_ID || t.author_id === BOT_ID) continue;
    if (!botCache.has(t.author_id)) {
      const m = await rest(`/guilds/${GUILD_ID}/members/${t.author_id}`).catch(() => null);
      botCache.set(t.author_id, !m || Boolean(m.user?.bot));
    }
    if (botCache.get(t.author_id)) continue;
    const prev = users[t.author_id] || { count: 0, last_at: 0 };
    users[t.author_id] = {
      last_channel_id: (t.at || 0) >= prev.last_at ? t.channel_id : prev.last_channel_id,
      last_at: Math.max(t.at || 0, prev.last_at),
      count: prev.count + 1,
    };
  }
  scope.writeJsonAtomic(CONTACTS_FILE, { users, seeded_from: 'triggers.json', seeded_at: Date.now() });
  return { seeded: true, users };
}

// ---------- roast state ----------
function loadRoastState() { return scope.readJson(ROAST_FILE, { history: [] }); }
function saveRoastState(st) { scope.writeJsonAtomic(ROAST_FILE, st); }

/**
 * Pick a target: eligible contacts still in the guild (not bots, not creator,
 * not the bot), preferring people not roasted in the last AVOID_DAYS days.
 */
async function pickTarget({ forcedId = null, rand = Math.random, now = Date.now() } = {}) {
  const contacts = loadContacts().users || {};
  const history = loadRoastState().history || [];
  let ids = forcedId ? [String(forcedId)] : Object.keys(contacts);
  ids = ids.filter((id) => id !== CREATOR_ID && id !== BOT_ID);
  const recent = new Set(history.filter((h) => now - (h.at || 0) < AVOID_DAYS * 86400000).map((h) => h.user_id));
  const fresh = ids.filter((id) => !recent.has(id));
  const order = (arr) => arr.map((id) => [rand(), id]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  for (const id of [...order(fresh), ...order(ids.filter((id) => recent.has(id)))]) {
    const m = await rest(`/guilds/${GUILD_ID}/members/${id}`).catch(() => null);
    if (!m || m.user?.bot) continue;
    return { member: m, contact: contacts[id] || null, recently_roasted: recent.has(id) };
  }
  return null;
}

function readMemory(userId) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, `${userId}.json`), 'utf8'));
    return { userId, memoryText: m.memoryText ? trunc(m.memoryText, 2000) : null, updatedAt: m.updatedAt || null };
  } catch { return { userId, memoryText: null, updatedAt: null }; }
}

function activeSkills() {
  const doc = scope.readJson(SKILLS_FILE, { skills: [] });
  return (doc.skills || []).filter((s) => s && !s.deletedAt).map((s) => ({ id: s.id, trigger: trunc(s.trigger, 120), rule: trunc(s.rule, 600) }));
}

function parisTime(ms) {
  return new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
}
function snowTime(id) { return Number((BigInt(id) >> 22n) + 1420070400000n); }

/** Build the routine payload (no message_id: standalone post). */
async function buildRoastPayload({ forcedId = null, guildInfo = null, rand } = {}) {
  const pick = await pickTarget({ forcedId, rand });
  if (!pick) return null;
  const m = pick.member;
  const target = { id: m.user.id, name: m.nick || m.user.global_name || m.user.username, username: m.user.username };
  const { by, textAgents } = await agentsChannels();
  let channelId = pick.contact?.last_channel_id;
  if (!channelId || !by.has(channelId) || !scope.isInAgents(channelId, (x) => by.get(x) || null)) channelId = FALLBACK_CHANNEL_ID;
  // Roast material: the target's latest messages in AGENTS channels.
  const mine = [];
  let channelRecent = [];
  for (const ch of textAgents) {
    const msgs = (await rest(`/channels/${ch.id}/messages?limit=100`).catch(() => null)) || [];
    if (ch.id === channelId) {
      channelRecent = msgs.slice(0, 10).reverse().map((x) => ({ author: x.member?.nick || x.author?.global_name || x.author?.username, author_id: x.author?.id, content: trunc(x.content, 400) }));
    }
    for (const x of msgs) {
      if (x.author?.id === target.id && String(x.content || '').trim()) {
        mine.push({ channel_id: ch.id, channel: ch.name, at_ms: snowTime(x.id), content: trunc(x.content, 300) });
      }
    }
  }
  mine.sort((a, b) => b.at_ms - a.at_ms);
  const targetMessages = mine.slice(0, TARGET_MSG_LIMIT).reverse().map(({ at_ms, ...rest_ }) => ({ ...rest_, at: parisTime(at_ms) }));
  const tMem = readMemory(target.id);
  const guild = guildInfo || {
    id: GUILD_ID,
    channels: [...by.values()].filter((c) => [0, 2, 4, 5, 13, 15].includes(c.type)).map((c) => ({ id: c.id, name: c.name, agents: scope.isInAgents(c.id, (x) => by.get(x) || null) || undefined })),
  };
  return {
    guild_id: GUILD_ID,
    channel_id: channelId,
    message_id: null,
    is_dm: false,
    in_agents: true,
    trigger: 'daily_roast',
    author: { id: null, username: 'daily_roast', display_name: 'Roast du jour (automatique)', bot: false, system: true },
    content: `Roast du jour : <@${target.id}>`,
    target,
    target_messages: targetMessages,
    target_contact: pick.contact ? { last_channel_id: pick.contact.last_channel_id, last_at: parisTime(pick.contact.last_at), count: pick.contact.count } : null,
    recently_roasted: pick.recently_roasted,
    recent: channelRecent,
    referenced: null,
    mentions: { users: [{ id: target.id, name: target.name }], roles: [], channels: [] },
    guild,
    memory: { author: { userId: null, memoryText: null, updatedAt: null }, mentioned: [tMem], target: tMem },
    skills: activeSkills(),
  };
}

async function postWebhook(payload) {
  const url = config.ROUTINE_WEBHOOK_URL;
  const key = config.ROUTINE_WEBHOOK_KEY;
  if (!url || !key) throw new Error('ROUTINE_WEBHOOK_URL/ROUTINE_WEBHOOK_KEY missing');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), signal: ac.signal });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: text.replace(/\s+/g, ' ').slice(0, 200) };
  } finally { clearTimeout(timer); }
}

function recordRoast(entry) {
  scope.withLock(ROAST_FILE, () => {
    const st = loadRoastState();
    st.history = [...(st.history || []), entry].slice(-100);
    saveRoastState(st);
  });
}

module.exports = {
  CONTACTS_FILE, ROAST_FILE, FALLBACK_CHANNEL_ID, AVOID_DAYS,
  recordContact, loadContacts, seedContacts, pickTarget, buildRoastPayload, postWebhook,
  loadRoastState, saveRoastState, recordRoast, agentsChannels,
};
