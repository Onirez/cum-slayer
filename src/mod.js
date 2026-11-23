'use strict';

/**
 * Discord server tools (REST v10) with authorization enforced in code.
 * Used by act.js (actions array) and by mod.sh (read helpers only).
 * DISCORD_BOT_TOKEN is read from the environment and never logged.
 *
 * Authorization model:
 *  - The trigger message is fetched from Discord; its real author.id is the
 *    requester. The JSON author_id must match it.
 *  - The trigger must be recorded by bridge.js in data/triggers.json and be
 *    recent (TRIGGER_MAX_AGE_MS), so an old creator message can't be replayed.
 *  - Admin actions require requester === CREATOR_ID. Read helpers, pin/unpin
 *    and create_thread are open to anyone.
 *  - Discord Agent Rules (AGENTS.md): EVERY mutating action is validated
 *    (requester's real Discord permissions from roles + channel overwrites,
 *    role/member hierarchy, hard limits), stored as a pending plan in
 *    data/pending_plans.json and posted with Confirmer/Annuler buttons.
 *    Only bridge.js executes it, after the requester clicks Confirmer, and it
 *    re-verifies everything first. act.sh never executes mutating actions.
 *  - Hard rules (even for the creator): never target the creator/owner with
 *    kick/ban/timeout/role removal/voice disconnect, never grant Administrator,
 *    never @everyone/@here, no guild delete, no webhooks/integrations.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeMassMentions, splitContent, allowedMentions } = require('./lib');

const config = require('./config');
const API = 'https://discord.com/api/v10';
const GUILD_ID = config.GUILD_ID;
const CREATOR_ID = config.CREATOR_ID;
const BOT_ID = config.BOT_APP_ID;
const ADMINISTRATOR = 1n << 3n;
const MAX_MUTATING = 10;
const MAX_ACTIONS = 15;
const TRIGGER_MAX_AGE_MS = 15 * 60 * 1000;
const DATA_DIR = config.DATA_DIR;
const TRIGGERS_FILE = config.TRIGGERS_FILE;
const CONSUMED_FILE = config.CONSUMED_FILE;
const MOD_LOG = config.MOD_LOG;
const DISCORD_EPOCH = 1420070400000n;

const READ_ACTIONS = new Set([
  'list_members', 'list_roles', 'list_channels', 'member_info', 'list_bans',
  'audit_log', 'list_emojis',
]);
const OPEN_ACTIONS = new Set(['pin', 'unpin', 'create_thread']);
const ADMIN_ACTIONS = new Set([
  'delete_message', 'bulk_delete', 'timeout', 'remove_timeout', 'kick', 'ban', 'unban',
  'add_role', 'remove_role', 'create_role', 'edit_role', 'delete_role', 'set_nick',
  'create_channel', 'edit_channel', 'delete_channel', 'move_voice', 'disconnect_voice',
  'create_invite', 'edit_message', 'send_dm', 'send_message', 'create_emoji', 'delete_emoji',
]);
const PROTECTED_FROM = new Set(['kick', 'ban', 'timeout', 'remove_role', 'disconnect_voice']);

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function modLog(line) {
  try { fs.appendFileSync(MOD_LOG, `${ts()} ${line}\n`); } catch { /* ignore */ }
}

class ApiError extends Error {
  constructor(status, body) { super(`Discord API error status=${status} body=${body}`); this.status = status; }
}

function isSnowflake(v) { return typeof v === 'string' && /^\d{5,25}$/.test(v); }
function sf(v, field) {
  const s = v == null ? '' : String(v).trim();
  if (!isSnowflake(s)) throw new Error(`${field} must be a Discord ID`);
  return s;
}
function snowflakeTime(id) { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); }
function clean(text, max) {
  let s = sanitizeMassMentions(String(text ?? '')).replace(/[\r\n]+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

async function api(method, p, { body, reason, dryRun = false, raw = false } = {}) {
  const url = `${API}${p}`;
  const mutating = method !== 'GET';
  if (dryRun && mutating) {
    console.log(`dry-run ${method} ${url}${reason ? ` reason="${reason}"` : ''}`);
    if (body !== undefined) console.log(JSON.stringify(body).slice(0, 500));
    return { dryRun: true, data: null };
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  const headers = { Authorization: `Bot ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(String(reason).slice(0, 400));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429) {
      const j = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(5000, Math.ceil((j.retry_after || 1) * 1000))));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, String(text).replace(/\s+/g, ' ').slice(0, 300));
    if (raw) return { data: text };
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { data };
  }
  throw new ApiError(429, 'rate limited');
}

// ---------- cached guild lookups (per process) ----------
const cache = {};
async function guild() { return (cache.guild ||= (await api('GET', `/guilds/${GUILD_ID}`)).data); }
async function roles() { return (cache.roles ||= (await api('GET', `/guilds/${GUILD_ID}/roles`)).data); }
async function channel(id) {
  cache.ch ||= {};
  if (!cache.ch[id]) cache.ch[id] = (await api('GET', `/channels/${id}`)).data;
  return cache.ch[id];
}
async function member(userId) {
  cache.m ||= {};
  if (cache.m[userId] === undefined) {
    try { cache.m[userId] = (await api('GET', `/guilds/${GUILD_ID}/members/${userId}`)).data; } catch (e) {
      if (e.status === 404) cache.m[userId] = null; else throw e;
    }
  }
  return cache.m[userId];
}

async function guildChannel(id, field = 'channel_id') {
  const cid = sf(id, field);
  const ch = await channel(cid);
  if (!ch || ch.guild_id !== GUILD_ID) throw new Error(`${field} ${cid} is not in the allowed guild`);
  return ch;
}
async function guildMember(id, field = 'user_id') {
  const uid = sf(id, field);
  const m = await member(uid);
  if (!m) throw new Error(`user ${uid} is not a member of the allowed guild`);
  return m;
}
async function guildRole(id) {
  const rid = sf(id, 'role_id');
  const r = (await roles()).find((x) => x.id === rid);
  if (!r) throw new Error(`role ${rid} is not in the allowed guild`);
  return r;
}
async function isProtected(userId) {
  if (userId === CREATOR_ID) return 'creator';
  const g = await guild();
  if (userId === g.owner_id) return 'server owner';
  if (userId === BOT_ID) return 'bot itself';
  return null;
}
function hasAdminBit(perms) {
  try { return (BigInt(String(perms ?? '0')) & ADMINISTRATOR) === ADMINISTRATOR; } catch { return true; }
}
function checkPerms(perms) {
  if (perms === undefined || perms === null) return undefined;
  const s = String(perms);
  if (!/^\d{1,25}$/.test(s)) throw new Error('permissions must be a decimal bitfield string');
  if (hasAdminBit(s)) throw new Error('granting Administrator is forbidden');
  return s;
}
function roleBody(a) {
  const b = {};
  if (a.name !== undefined) {
    b.name = clean(a.name, 100);
    if (/^@?(everyone|here)$/i.test(b.name.replace(/[{}]/g, ''))) throw new Error('forbidden role name');
  }
  if (a.color !== undefined) b.color = typeof a.color === 'string' ? parseInt(a.color.replace('#', ''), 16) : Number(a.color);
  if (a.hoist !== undefined) b.hoist = Boolean(a.hoist);
  if (a.mentionable !== undefined) b.mentionable = Boolean(a.mentionable);
  const perms = checkPerms(a.permissions);
  if (perms !== undefined) b.permissions = perms;
  return b;
}
const CHANNEL_KINDS = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15 };
function channelBody(a, creating) {
  const b = {};
  if (a.name !== undefined) b.name = clean(a.name, 100);
  if (creating && !b.name) throw new Error('name is required');
  if (a.topic !== undefined) b.topic = clean(a.topic, 1024);
  if (a.nsfw !== undefined) b.nsfw = Boolean(a.nsfw);
  if (a.slowmode !== undefined) b.rate_limit_per_user = Math.max(0, Math.min(21600, Number(a.slowmode) || 0));
  if (a.user_limit !== undefined) b.user_limit = Math.max(0, Math.min(99, Number(a.user_limit) || 0));
  if (a.position !== undefined) b.position = Number(a.position) || 0;
  if (creating) {
    const kind = String(a.kind || 'text');
    if (!(kind in CHANNEL_KINDS)) throw new Error(`kind must be one of ${Object.keys(CHANNEL_KINDS).join('/')}`);
    b.type = CHANNEL_KINDS[kind];
  }
  return b;
}

// ---------- compact read formatters ----------
const CH_TYPE = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 10: 'thread', 11: 'thread', 12: 'private_thread', 13: 'stage', 15: 'forum', 16: 'media' };
function fmtRole(r) {
  return { id: r.id, name: r.name, position: r.position, admin: hasAdminBit(r.permissions), managed: !!r.managed };
}
function fmtMember(m) {
  return {
    id: m.user?.id, username: m.user?.username, name: m.nick || m.user?.global_name || m.user?.username,
    bot: !!m.user?.bot, roles: m.roles, timeout_until: m.communication_disabled_until || null, joined_at: m.joined_at,
  };
}

// ---------- actions ----------
const handlers = {
  async list_roles() {
    const rs = (await roles()).slice().sort((a, b) => b.position - a.position);
    return rs.map(fmtRole);
  },
  async list_channels() {
    const chs = (await api('GET', `/guilds/${GUILD_ID}/channels`)).data;
    return chs.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((c) => ({
      id: c.id, name: c.name, type: CH_TYPE[c.type] || String(c.type), parent_id: c.parent_id || null, nsfw: !!c.nsfw,
    }));
  },
  async list_members(a) {
    const limit = Math.max(1, Math.min(1000, Number(a.limit) || 100));
    let ms;
    if (a.query) {
      ms = (await api('GET', `/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(String(a.query).slice(0, 100))}&limit=${Math.min(limit, 1000)}`)).data;
    } else {
      ms = (await api('GET', `/guilds/${GUILD_ID}/members?limit=${limit}`)).data;
    }
    return ms.map(fmtMember);
  },
  async member_info(a) { return fmtMember(await guildMember(a.user_id)); },
  async list_bans(a) {
    const limit = Math.max(1, Math.min(1000, Number(a.limit) || 100));
    const bans = (await api('GET', `/guilds/${GUILD_ID}/bans?limit=${limit}`)).data;
    return bans.map((b) => ({ id: b.user?.id, username: b.user?.username, reason: b.reason }));
  },
  async audit_log(a) {
    const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(50, Number(a.limit) || 10))) });
    if (a.action_type !== undefined) q.set('action_type', String(Number(a.action_type)));
    if (a.user_id) q.set('user_id', sf(a.user_id, 'user_id'));
    const log = (await api('GET', `/guilds/${GUILD_ID}/audit-logs?${q}`)).data;
    return (log.audit_log_entries || []).map((e) => ({
      id: e.id, action_type: e.action_type, user_id: e.user_id, target_id: e.target_id, reason: e.reason || null,
      at: new Date(snowflakeTime(e.id)).toISOString(),
    }));
  },
  async list_emojis() {
    const es = (await api('GET', `/guilds/${GUILD_ID}/emojis`)).data;
    return es.map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, tag: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` }));
  },

  async pin(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const mid = sf(a.message_id, 'message_id');
    try { await api('PUT', `/channels/${ch.id}/messages/pins/${mid}`, { reason: ctx.reason, dryRun: ctx.dryRun }); } catch (e) {
      if (e.status !== 404) throw e;
      await api('PUT', `/channels/${ch.id}/pins/${mid}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    }
    return { pinned: mid };
  },
  async unpin(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const mid = sf(a.message_id, 'message_id');
    try { await api('DELETE', `/channels/${ch.id}/messages/pins/${mid}`, { reason: ctx.reason, dryRun: ctx.dryRun }); } catch (e) {
      if (e.status !== 404) throw e;
      await api('DELETE', `/channels/${ch.id}/pins/${mid}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    }
    return { unpinned: mid };
  },
  async create_thread(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const name = clean(a.name, 100);
    if (!name) throw new Error('name is required');
    const minutes = [60, 1440, 4320, 10080].includes(Number(a.auto_archive_minutes)) ? Number(a.auto_archive_minutes) : 1440;
    let r;
    if (a.message_id) {
      r = await api('POST', `/channels/${ch.id}/messages/${sf(a.message_id, 'message_id')}/threads`, { body: { name, auto_archive_duration: minutes }, reason: ctx.reason, dryRun: ctx.dryRun });
    } else {
      r = await api('POST', `/channels/${ch.id}/threads`, { body: { name, auto_archive_duration: minutes, type: a.private ? 12 : 11 }, reason: ctx.reason, dryRun: ctx.dryRun });
    }
    return { thread_id: r.data?.id || null };
  },

  async delete_message(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const mid = sf(a.message_id, 'message_id');
    await api('DELETE', `/channels/${ch.id}/messages/${mid}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { deleted: mid };
  },
  async bulk_delete(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const count = Math.max(1, Math.min(100, Number(a.count) || 0));
    const userFilter = a.user_id ? sf(a.user_id, 'user_id') : null;
    const msgs = (await api('GET', `/channels/${ch.id}/messages?limit=${userFilter ? 100 : count}`)).data;
    const cutoff = Date.now() - 14 * 24 * 3600 * 1000 + 60_000;
    let ids = msgs.filter((m) => !m.pinned && (!userFilter || m.author?.id === userFilter)).map((m) => m.id);
    ids = ids.slice(0, count).filter((id) => snowflakeTime(id) > cutoff);
    if (ids.length === 0) return { deleted: 0 };
    if (ids.length === 1) await api('DELETE', `/channels/${ch.id}/messages/${ids[0]}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    else await api('POST', `/channels/${ch.id}/messages/bulk-delete`, { body: { messages: ids }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { deleted: ids.length };
  },
  async edit_message(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const mid = sf(a.message_id, 'message_id');
    const m = (await api('GET', `/channels/${ch.id}/messages/${mid}`)).data;
    if (m.author?.id !== BOT_ID) throw new Error('can only edit messages sent by the bot');
    const content = sanitizeMassMentions(String(a.content ?? '')).slice(0, 2000);
    if (!content.trim()) throw new Error('content is required');
    await api('PATCH', `/channels/${ch.id}/messages/${mid}`, { body: { content, allowed_mentions: allowedMentions() }, dryRun: ctx.dryRun });
    return { edited: mid };
  },
  async send_message(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const ids = [];
    for (const chunk of splitContent(sanitizeMassMentions(a.text))) {
      if (!chunk.trim()) continue;
      const r = await api('POST', `/channels/${ch.id}/messages`, { body: { content: chunk, allowed_mentions: allowedMentions() }, dryRun: ctx.dryRun });
      if (r.data?.id) ids.push(r.data.id);
    }
    return { sent: ids };
  },
  async send_dm(a, ctx) {
    const m = await guildMember(a.user_id);
    if (!require('./scope').hasInteracted(m.user.id)) throw new Error('refused: no prior interaction with this user (DM rule)');
    const text = sanitizeMassMentions(a.text);
    if (!text.trim()) throw new Error('text is required');
    const dm = await api('POST', '/users/@me/channels', { body: { recipient_id: m.user.id }, dryRun: ctx.dryRun });
    const cid = dm.data?.id || 'DRY_RUN_DM';
    for (const chunk of splitContent(text)) {
      if (chunk.trim()) await api('POST', `/channels/${cid}/messages`, { body: { content: chunk, allowed_mentions: allowedMentions() }, dryRun: ctx.dryRun });
    }
    return { dm: m.user.id };
  },

  async timeout(a, ctx) {
    const m = await guildMember(a.user_id);
    const secs = Math.max(1, Math.min(28 * 24 * 3600, Number(a.duration_seconds) || 600));
    const until = new Date(Date.now() + secs * 1000).toISOString();
    await api('PATCH', `/guilds/${GUILD_ID}/members/${m.user.id}`, { body: { communication_disabled_until: until }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { timeout: m.user.id, until };
  },
  async remove_timeout(a, ctx) {
    const m = await guildMember(a.user_id);
    await api('PATCH', `/guilds/${GUILD_ID}/members/${m.user.id}`, { body: { communication_disabled_until: null }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { untimeout: m.user.id };
  },
  async kick(a, ctx) {
    const m = await guildMember(a.user_id);
    await api('DELETE', `/guilds/${GUILD_ID}/members/${m.user.id}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { kicked: m.user.id };
  },
  async ban(a, ctx) {
    const uid = sf(a.user_id, 'user_id');
    const del = Math.max(0, Math.min(604800, Number(a.delete_message_seconds) || 0));
    await api('PUT', `/guilds/${GUILD_ID}/bans/${uid}`, { body: { delete_message_seconds: del }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { banned: uid };
  },
  async unban(a, ctx) {
    const uid = sf(a.user_id, 'user_id');
    await api('DELETE', `/guilds/${GUILD_ID}/bans/${uid}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { unbanned: uid };
  },
  async add_role(a, ctx) {
    const m = await guildMember(a.user_id);
    const r = await guildRole(a.role_id);
    if (r.id === GUILD_ID || r.managed) throw new Error('cannot assign @everyone or managed roles');
    if (hasAdminBit(r.permissions)) throw new Error('granting an Administrator role is forbidden');
    await api('PUT', `/guilds/${GUILD_ID}/members/${m.user.id}/roles/${r.id}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { added: r.id, to: m.user.id };
  },
  async remove_role(a, ctx) {
    const m = await guildMember(a.user_id);
    const r = await guildRole(a.role_id);
    await api('DELETE', `/guilds/${GUILD_ID}/members/${m.user.id}/roles/${r.id}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { removed: r.id, from: m.user.id };
  },
  async create_role(a, ctx) {
    const b = roleBody(a);
    if (!b.name) throw new Error('name is required');
    if (b.permissions === undefined) b.permissions = '0';
    const r = await api('POST', `/guilds/${GUILD_ID}/roles`, { body: b, reason: ctx.reason, dryRun: ctx.dryRun });
    cache.roles = undefined;
    return { role_id: r.data?.id || null };
  },
  async edit_role(a, ctx) {
    const r = await guildRole(a.role_id);
    if (r.managed) throw new Error('cannot edit managed roles');
    const b = roleBody(a);
    if (Object.keys(b).length === 0) throw new Error('nothing to edit');
    await api('PATCH', `/guilds/${GUILD_ID}/roles/${r.id}`, { body: b, reason: ctx.reason, dryRun: ctx.dryRun });
    return { edited: r.id };
  },
  async delete_role(a, ctx) {
    const r = await guildRole(a.role_id);
    if (r.id === GUILD_ID || r.managed) throw new Error('cannot delete @everyone or managed roles');
    for (const pid of [CREATOR_ID, (await guild()).owner_id]) {
      const pm = await member(pid);
      if (pm && pm.roles.includes(r.id)) throw new Error('role is held by the creator/owner; refusing');
    }
    await api('DELETE', `/guilds/${GUILD_ID}/roles/${r.id}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { deleted_role: r.id };
  },
  async set_nick(a, ctx) {
    const nick = a.nick == null || a.nick === '' ? null : clean(a.nick, 32);
    if (a.user_id === '@me' || a.user_id === BOT_ID) {
      await api('PATCH', `/guilds/${GUILD_ID}/members/@me`, { body: { nick }, reason: ctx.reason, dryRun: ctx.dryRun });
      return { nick_self: nick };
    }
    const m = await guildMember(a.user_id);
    await api('PATCH', `/guilds/${GUILD_ID}/members/${m.user.id}`, { body: { nick }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { nick: nick, user: m.user.id };
  },
  async create_channel(a, ctx) {
    const b = channelBody(a, true);
    if (a.parent_id) b.parent_id = (await guildChannel(a.parent_id, 'parent_id')).id;
    const r = await api('POST', `/guilds/${GUILD_ID}/channels`, { body: b, reason: ctx.reason, dryRun: ctx.dryRun });
    return { channel_id: r.data?.id || null };
  },
  async edit_channel(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const b = channelBody(a, false);
    if (a.parent_id !== undefined) b.parent_id = a.parent_id ? (await guildChannel(a.parent_id, 'parent_id')).id : null;
    if (Object.keys(b).length === 0) throw new Error('nothing to edit');
    await api('PATCH', `/channels/${ch.id}`, { body: b, reason: ctx.reason, dryRun: ctx.dryRun });
    return { edited_channel: ch.id };
  },
  async delete_channel(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const g = await guild();
    if ([g.system_channel_id, g.rules_channel_id, g.public_updates_channel_id].includes(ch.id)) {
      throw new Error('refusing to delete the system/rules/updates channel');
    }
    await api('DELETE', `/channels/${ch.id}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { deleted_channel: ch.id };
  },
  async move_voice(a, ctx) {
    const m = await guildMember(a.user_id);
    const ch = await guildChannel(a.channel_id);
    if (![2, 13].includes(ch.type)) throw new Error('channel_id must be a voice/stage channel');
    await api('PATCH', `/guilds/${GUILD_ID}/members/${m.user.id}`, { body: { channel_id: ch.id }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { moved: m.user.id, to: ch.id };
  },
  async disconnect_voice(a, ctx) {
    const m = await guildMember(a.user_id);
    await api('PATCH', `/guilds/${GUILD_ID}/members/${m.user.id}`, { body: { channel_id: null }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { disconnected: m.user.id };
  },
  async create_invite(a, ctx) {
    const ch = await guildChannel(a.channel_id);
    const body = {
      max_age: Math.max(0, Math.min(604800, Number(a.max_age ?? 86400))),
      max_uses: Math.max(0, Math.min(100, Number(a.max_uses ?? 0))),
      temporary: Boolean(a.temporary),
      unique: true,
    };
    const r = await api('POST', `/channels/${ch.id}/invites`, { body, reason: ctx.reason, dryRun: ctx.dryRun });
    const url = r.data?.code ? `https://discord.gg/${r.data.code}` : null;
    return { invite: url };
  },
  async create_emoji(a, ctx) {
    const name = String(a.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
    if (name.length < 2) throw new Error('name must be 2-32 chars [A-Za-z0-9_]');
    const u = new URL(String(a.url || ''));
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error('url must be http(s)');
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname)) throw new Error('private url refused');
    let image = 'data:image/png;base64,DRYRUN';
    if (!ctx.dryRun) {
      const res = await fetch(u, { redirect: 'follow' });
      if (!res.ok) throw new Error(`image download failed status=${res.status}`);
      const type = (res.headers.get('content-type') || '').split(';')[0];
      if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) throw new Error(`unsupported image type ${type}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 256 * 1024) throw new Error('image larger than 256 KB');
      image = `data:${type};base64,${buf.toString('base64')}`;
    } else {
      console.log(`dry-run GET ${u.href} (emoji image)`);
    }
    const r = await api('POST', `/guilds/${GUILD_ID}/emojis`, { body: { name, image }, reason: ctx.reason, dryRun: ctx.dryRun });
    return { emoji: r.data ? `<${r.data.animated ? 'a' : ''}:${r.data.name}:${r.data.id}>` : null };
  },
  async delete_emoji(a, ctx) {
    const eid = sf(a.emoji_id, 'emoji_id');
    await api('DELETE', `/guilds/${GUILD_ID}/emojis/${eid}`, { reason: ctx.reason, dryRun: ctx.dryRun });
    return { deleted_emoji: eid };
  },
};

function classify(type) {
  if (READ_ACTIONS.has(type)) return 'read';
  if (OPEN_ACTIONS.has(type)) return 'open';
  if (ADMIN_ACTIONS.has(type)) return 'admin';
  return null;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * Establish who really sent the trigger message.
 * Returns { realAuthor, isCreator, reason } where reason is set when admin
 * actions must be refused.
 */
async function verifyRequester({ channelId, messageId, claimedAuthor, dryRun }) {
  // refuse: blocks every mutating action. isCreator gates admin actions.
  const out = { realAuthor: null, isCreator: false, refuse: null, guildOk: false };
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) { out.refuse = 'missing channel_id/message_id'; return out; }
  let msg;
  try { msg = (await api('GET', `/channels/${channelId}/messages/${messageId}`)).data; } catch (e) {
    out.refuse = `cannot fetch trigger message (${e.status || e.message})`; return out;
  }
  out.realAuthor = msg.author?.id || null;
  // Bots and webhooks can never request Discord actions (AGENTS.md).
  if (msg.author?.bot || msg.webhook_id) { out.refuse = 'bot/webhook authors cannot request Discord actions'; return out; }
  let ch;
  try { ch = await channel(channelId); } catch { ch = null; }
  const isDmChannel = ch && (ch.type === 1 || ch.type === 3);
  out.guildOk = Boolean(ch && (ch.guild_id === GUILD_ID || isDmChannel));
  if (!out.guildOk) { out.refuse = 'trigger is not in the allowed guild'; return out; }
  if (!claimedAuthor) { out.refuse = 'author_id missing in act.sh JSON'; return out; }
  if (String(claimedAuthor) !== out.realAuthor) { out.refuse = `author_id mismatch (claimed ${claimedAuthor}, real ${out.realAuthor})`; return out; }
  out.isCreator = out.realAuthor === CREATOR_ID;
  const maxAge = dryRun && process.env.ACT_MAX_AGE_MS ? Number(process.env.ACT_MAX_AGE_MS) : TRIGGER_MAX_AGE_MS;
  if (Date.now() - snowflakeTime(messageId) > maxAge) { out.refuse = 'trigger message too old'; return out; }
  const triggers = readJson(TRIGGERS_FILE, { triggers: [] }).triggers || [];
  const rec = triggers.find((t) => t.message_id === messageId);
  if (!rec || rec.author_id !== out.realAuthor) { out.refuse = 'message is not a recorded bridge trigger'; return out; }
  const consumed = readJson(CONSUMED_FILE, { ids: [] }).ids || [];
  if (consumed.includes(messageId) && !dryRun) { out.refuse = 'trigger already used for a plan'; return out; }
  return out;
}

function markConsumed(messageId) {
  const doc = readJson(CONSUMED_FILE, { ids: [] });
  const ids = (doc.ids || []).filter(Boolean);
  ids.push(messageId);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONSUMED_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ids: ids.slice(-500) }));
  fs.renameSync(tmp, CONSUMED_FILE);
}

// ---------- read helpers (executed immediately, no plan) ----------
async function runActions({ actions, dryRun }) {
  const results = [];
  if (!Array.isArray(actions) || actions.length === 0) return results;
  for (const a of actions.slice(0, MAX_ACTIONS)) {
    const type = String(a?.type || '');
    try {
      if (classify(type) !== 'read') throw new Error('mutating actions go through a confirmed plan (createPlan)');
      results.push({ type, ok: true, result: await handlers[type](a || {}, { dryRun }) });
    } catch (e) {
      results.push({ type, ok: false, error: e && e.message ? e.message : String(e) });
    }
  }
  return results;
}

// ---------- Discord Agent Rules: permission check + plan + confirmation ----------
// See AGENTS.md. Every mutating action is validated, shown as a plan of REST
// requests, and only executed by bridge.js after the requester clicks Confirmer.
const PLANS_FILE = config.PLANS_FILE;
const PLAN_TTL_MS = 10 * 60 * 1000;
const { P, basePermissions, channelPermissions, highestPosition, missing, big } = require('./perms');
const scope = require('./scope');

function resetCache() { for (const k of Object.keys(cache)) delete cache[k]; }

async function nameOfUser(uid) {
  const m = await member(uid).catch(() => null);
  if (m) return `@${m.nick || m.user?.global_name || m.user?.username || uid}`;
  return `user ${uid}`;
}
function chName(ch) { return ch ? `#${ch.name || ch.id}` : '#?'; }

/** Overwrite source for permission computation: threads use their parent. */
async function permChannel(ch) {
  if (ch && scope.THREAD_TYPES.has(ch.type) && ch.parent_id) return channel(ch.parent_id);
  return ch;
}

async function ensureBelow(kind, targetPos, requester, botMember, g, rs) {
  const rPos = highestPosition(requester, g, rs);
  const bPos = highestPosition(botMember, g, rs);
  if (!(targetPos < rPos)) throw new Error(`refused: ${kind} is not below the requester's highest role`);
  if (!(targetPos < bPos)) throw new Error(`refused: ${kind} is not below the bot's highest role`);
}

/**
 * Validate one mutating action for `requesterId` without executing it.
 * Returns { need, permCh, requests:[{method, route, human}] }.
 * Throws "refused: ..." on any failed check.
 */
async function prepare(type, a, requesterId) {
  const g = await guild();
  const rs = await roles();
  const requester = await member(requesterId);
  if (!requester) throw new Error('refused: requester is not a member of the guild');
  const botMember = await member(BOT_ID);
  const G = GUILD_ID;
  const days = (secs) => `${Math.round((secs / 86400) * 10) / 10} j`;
  let need = []; let permCh = null; const requests = []; const later = [];
  const req = (method, route, human) => requests.push({ method, route, human });

  if (PROTECTED_FROM.has(type) && a.user_id && a.user_id !== '@me') {
    const who = await isProtected(String(a.user_id));
    if (who) throw new Error(`refused: target is the ${who}`);
  }
  const memberHierarchy = async (m) => {
    if (m.user.id === g.owner_id) throw new Error('refused: target is the server owner');
    await ensureBelow('target member', highestPosition(m, g, rs), requester, botMember, g, rs);
  };

  switch (type) {
    case 'pin': case 'unpin': {
      const ch = await guildChannel(a.channel_id); const mid = sf(a.message_id, 'message_id');
      need = [[P.PIN_MESSAGES, P.MANAGE_MESSAGES]]; permCh = ch;
      req(type === 'pin' ? 'PUT' : 'DELETE', `/channels/${ch.id}/messages/pins/${mid}`, `${type === 'pin' ? 'épingler' : 'désépingler'} le message ${mid} dans ${chName(ch)}`);
      break;
    }
    case 'create_thread': {
      const ch = await guildChannel(a.channel_id); const name = clean(a.name, 100);
      if (!name) throw new Error('name is required');
      need = [[a.private && !a.message_id ? P.CREATE_PRIVATE_THREADS : P.CREATE_PUBLIC_THREADS]]; permCh = ch;
      if (a.message_id) req('POST', `/channels/${ch.id}/messages/${sf(a.message_id, 'message_id')}/threads`, `créer le fil « ${name} » sur un message de ${chName(ch)}`);
      else req('POST', `/channels/${ch.id}/threads`, `créer le fil ${a.private ? 'privé' : 'public'} « ${name} » dans ${chName(ch)}`);
      break;
    }
    case 'delete_message': {
      const ch = await guildChannel(a.channel_id); const mid = sf(a.message_id, 'message_id');
      need = [[P.MANAGE_MESSAGES]]; permCh = ch;
      req('DELETE', `/channels/${ch.id}/messages/${mid}`, `supprimer le message ${mid} dans ${chName(ch)}`);
      break;
    }
    case 'bulk_delete': {
      const ch = await guildChannel(a.channel_id);
      const count = Math.max(1, Math.min(100, Number(a.count) || 0));
      const who = a.user_id ? ` de ${await nameOfUser(sf(a.user_id, 'user_id'))}` : '';
      need = [[P.MANAGE_MESSAGES], [P.READ_MESSAGE_HISTORY]]; permCh = ch;
      req('GET', `/channels/${ch.id}/messages?limit=${a.user_id ? 100 : count}`, 'lister les messages récents (lecture)');
      req('POST', `/channels/${ch.id}/messages/bulk-delete`, `supprimer jusqu'à ${count} messages${who} dans ${chName(ch)} (non épinglés, < 14 j)`);
      break;
    }
    case 'edit_message': {
      const ch = await guildChannel(a.channel_id); const mid = sf(a.message_id, 'message_id');
      const m = (await api('GET', `/channels/${ch.id}/messages/${mid}`)).data;
      if (m.author?.id !== BOT_ID) throw new Error('can only edit messages sent by the bot');
      if (!String(a.content ?? '').trim()) throw new Error('content is required');
      need = [[P.MANAGE_MESSAGES]]; permCh = ch;
      req('PATCH', `/channels/${ch.id}/messages/${mid}`, `modifier le message du bot ${mid} dans ${chName(ch)}`);
      break;
    }
    case 'send_message': {
      const ch = await guildChannel(a.channel_id);
      const text = clean(a.text, 60);
      if (!text) throw new Error('text is required');
      need = [[P.VIEW_CHANNEL], [scope.THREAD_TYPES.has(ch.type) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES]]; permCh = ch;
      req('POST', `/channels/${ch.id}/messages`, `envoyer « ${text}${String(a.text).length > 60 ? '…' : ''} » dans ${chName(ch)}`);
      break;
    }
    case 'send_dm': {
      const m = await guildMember(a.user_id);
      if (!scope.hasInteracted(m.user.id)) throw new Error('refused: no prior interaction with this user (DM rule)');
      if (!String(a.text ?? '').trim()) throw new Error('text is required');
      need = [];
      req('POST', '/users/@me/channels', `ouvrir le DM avec ${await nameOfUser(m.user.id)}`);
      req('POST', '/channels/{dm}/messages', `envoyer « ${clean(a.text, 60)} » en DM`);
      break;
    }
    case 'timeout': case 'remove_timeout': {
      const m = await guildMember(a.user_id); later.push(() => memberHierarchy(m));
      need = [[P.MODERATE_MEMBERS]];
      const secs = Math.max(1, Math.min(28 * 24 * 3600, Number(a.duration_seconds) || 600));
      req('PATCH', `/guilds/${G}/members/${m.user.id}`, type === 'timeout' ? `timeout ${await nameOfUser(m.user.id)} pendant ${secs >= 3600 ? `${Math.round(secs / 360) / 10} h` : `${Math.round(secs / 6) / 10} min`}` : `retirer le timeout de ${await nameOfUser(m.user.id)}`);
      break;
    }
    case 'kick': {
      const m = await guildMember(a.user_id); later.push(() => memberHierarchy(m));
      need = [[P.KICK_MEMBERS]];
      req('DELETE', `/guilds/${G}/members/${m.user.id}`, `kick ${await nameOfUser(m.user.id)}`);
      break;
    }
    case 'ban': {
      const uid = sf(a.user_id, 'user_id');
      const m = await member(uid); if (m) later.push(() => memberHierarchy(m));
      const del = Math.max(0, Math.min(604800, Number(a.delete_message_seconds) || 0));
      need = [[P.BAN_MEMBERS]];
      req('PUT', `/guilds/${G}/bans/${uid}`, `ban ${await nameOfUser(uid)}${del ? `, supprimer ${days(del)} de messages` : ''}`);
      break;
    }
    case 'unban': {
      const uid = sf(a.user_id, 'user_id'); need = [[P.BAN_MEMBERS]];
      req('DELETE', `/guilds/${G}/bans/${uid}`, `déban user ${uid}`);
      break;
    }
    case 'add_role': case 'remove_role': {
      const m = await guildMember(a.user_id); const r = await guildRole(a.role_id);
      if (r.id === GUILD_ID || r.managed) throw new Error('cannot assign/remove @everyone or managed roles');
      if (type === 'add_role' && hasAdminBit(r.permissions)) throw new Error('granting an Administrator role is forbidden');
      later.push(() => ensureBelow(`role @${r.name}`, r.position, requester, botMember, g, rs));
      need = [[P.MANAGE_ROLES]];
      req(type === 'add_role' ? 'PUT' : 'DELETE', `/guilds/${G}/members/${m.user.id}/roles/${r.id}`, `${type === 'add_role' ? 'donner' : 'retirer'} le rôle @${r.name} ${type === 'add_role' ? 'à' : 'de'} ${await nameOfUser(m.user.id)}`);
      break;
    }
    case 'create_role': case 'edit_role': {
      const b = roleBody(a);
      let r = null;
      if (type === 'edit_role') {
        r = await guildRole(a.role_id);
        if (r.managed) throw new Error('cannot edit managed roles');
        if (Object.keys(b).length === 0) throw new Error('nothing to edit');
        later.push(() => ensureBelow(`role @${r.name}`, r.position, requester, botMember, g, rs));
      } else if (!b.name) throw new Error('name is required');
      if (b.permissions !== undefined) {
        const have = basePermissions(requester, g, rs);
        const want = big(b.permissions);
        if ((want & have) !== want) throw new Error('refused: role permissions exceed the requester\'s own permissions');
      }
      need = [[P.MANAGE_ROLES]];
      if (r) req('PATCH', `/guilds/${G}/roles/${r.id}`, `modifier le rôle @${r.name} (${Object.keys(b).join(', ')})`);
      else req('POST', `/guilds/${G}/roles`, `créer le rôle @${b.name}${b.permissions ? ` (permissions ${b.permissions})` : ' (sans permissions)'}`);
      break;
    }
    case 'delete_role': {
      const r = await guildRole(a.role_id);
      if (r.id === GUILD_ID || r.managed) throw new Error('cannot delete @everyone or managed roles');
      for (const pid of [CREATOR_ID, g.owner_id]) {
        const pm = await member(pid);
        if (pm && pm.roles.includes(r.id)) throw new Error('role is held by the creator/owner; refusing');
      }
      later.push(() => ensureBelow(`role @${r.name}`, r.position, requester, botMember, g, rs));
      need = [[P.MANAGE_ROLES]];
      req('DELETE', `/guilds/${G}/roles/${r.id}`, `supprimer le rôle @${r.name}`);
      break;
    }
    case 'set_nick': {
      const nick = a.nick == null || a.nick === '' ? null : clean(a.nick, 32);
      need = [[P.MANAGE_NICKNAMES]];
      if (a.user_id === '@me' || a.user_id === BOT_ID) {
        req('PATCH', `/guilds/${G}/members/@me`, `renommer le bot en « ${nick ?? '(reset)'} »`);
      } else {
        const m = await guildMember(a.user_id); later.push(() => memberHierarchy(m));
        req('PATCH', `/guilds/${G}/members/${m.user.id}`, `renommer ${await nameOfUser(m.user.id)} en « ${nick ?? '(reset)'} »`);
      }
      break;
    }
    case 'create_channel': {
      const b = channelBody(a, true);
      let parent = null;
      if (a.parent_id) parent = await guildChannel(a.parent_id, 'parent_id');
      need = [[P.MANAGE_CHANNELS]]; permCh = parent;
      req('POST', `/guilds/${G}/channels`, `créer le salon ${Object.keys(CHANNEL_KINDS).find((k) => CHANNEL_KINDS[k] === b.type)} « ${b.name} »${parent ? ` dans ${parent.name}` : ''}`);
      break;
    }
    case 'edit_channel': {
      const ch = await guildChannel(a.channel_id);
      const b = channelBody(a, false);
      if (a.parent_id) await guildChannel(a.parent_id, 'parent_id');
      if (Object.keys(b).length === 0 && a.parent_id === undefined) throw new Error('nothing to edit');
      need = [[P.MANAGE_CHANNELS]]; permCh = ch;
      req('PATCH', `/channels/${ch.id}`, `modifier ${chName(ch)} (${[...Object.keys(b), ...(a.parent_id !== undefined ? ['parent_id'] : [])].join(', ')})`);
      break;
    }
    case 'delete_channel': {
      const ch = await guildChannel(a.channel_id);
      if ([g.system_channel_id, g.rules_channel_id, g.public_updates_channel_id].includes(ch.id)) throw new Error('refusing to delete the system/rules/updates channel');
      need = [[P.MANAGE_CHANNELS]]; permCh = ch;
      req('DELETE', `/channels/${ch.id}`, `supprimer le salon ${chName(ch)}`);
      break;
    }
    case 'move_voice': {
      const m = await guildMember(a.user_id); const ch = await guildChannel(a.channel_id);
      if (![2, 13].includes(ch.type)) throw new Error('channel_id must be a voice/stage channel');
      need = [[P.MOVE_MEMBERS]]; permCh = ch;
      req('PATCH', `/guilds/${G}/members/${m.user.id}`, `déplacer ${await nameOfUser(m.user.id)} vers 🔊${ch.name}`);
      break;
    }
    case 'disconnect_voice': {
      const m = await guildMember(a.user_id); need = [[P.MOVE_MEMBERS]];
      req('PATCH', `/guilds/${G}/members/${m.user.id}`, `déconnecter ${await nameOfUser(m.user.id)} du vocal`);
      break;
    }
    case 'create_invite': {
      const ch = await guildChannel(a.channel_id); need = [[P.CREATE_INSTANT_INVITE]]; permCh = ch;
      req('POST', `/channels/${ch.id}/invites`, `créer une invitation pour ${chName(ch)} (durée ${Number(a.max_age ?? 86400)} s, max ${Number(a.max_uses ?? 0) || '∞'} utilisations)`);
      break;
    }
    case 'create_emoji': {
      const name = String(a.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
      if (name.length < 2) throw new Error('name must be 2-32 chars [A-Za-z0-9_]');
      const u = new URL(String(a.url || ''));
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('url must be http(s)');
      need = [[P.MANAGE_GUILD_EXPRESSIONS, P.CREATE_GUILD_EXPRESSIONS]];
      req('POST', `/guilds/${G}/emojis`, `créer l'émoji :${name}: depuis ${u.hostname}`);
      break;
    }
    case 'delete_emoji': {
      const eid = sf(a.emoji_id, 'emoji_id'); need = [[P.MANAGE_GUILD_EXPRESSIONS]];
      req('DELETE', `/guilds/${G}/emojis/${eid}`, `supprimer l'émoji ${eid}`);
      break;
    }
    default: throw new Error('unknown mutating action type');
  }

  // Deterministic permission check for the requester (owner/Administrator = all).
  const src = permCh ? await permChannel(permCh) : null;
  const perms = src ? channelPermissions(requester, g, rs, src) : basePermissions(requester, g, rs);
  const lack = missing(perms, need);
  if (lack.length) throw new Error(`refused: requester lacks ${lack.join(', ')}${permCh ? ` in ${chName(permCh)}` : ''}`);
  // Hierarchy checks (role/member must be below the requester and the bot).
  for (const check of later) await check();
  return { need, permCh: permCh?.id || null, requests };
}

/** Validate a whole mutating batch. Any failure refuses the whole plan. */
async function validateBatch(actions, requesterId, isCreator) {
  const list = actions.slice(0, MAX_MUTATING);
  if (actions.length > MAX_MUTATING) throw new Error(`refused: max ${MAX_MUTATING} mutating actions per plan`);
  const steps = [];
  for (const [i, a] of list.entries()) {
    const type = String(a?.type || '');
    const kind = classify(type);
    try {
      if (!kind || kind === 'read') throw new Error('not a mutating action');
      if (kind === 'admin' && !isCreator) throw new Error('refused: admin actions are reserved to the creator');
      steps.push({ index: i, type, args: a, ...(await prepare(type, a || {}, requesterId)) });
    } catch (e) {
      const err = new Error(`action#${i} ${type}: ${e && e.message ? e.message : e}`);
      err.index = i;
      throw err;
    }
  }
  return steps;
}

// ---------- plan storage ----------
function loadPlans() { return readJson(PLANS_FILE, { plans: [] }); }
function savePlans(doc) {
  const keep = (doc.plans || []).filter((p) => p.status === 'pending' || Date.now() - (p.created_at || 0) < 7 * 24 * 3600 * 1000).slice(-200);
  scope.writeJsonAtomic(PLANS_FILE, { plans: keep });
}
function updatePlan(id, fn) {
  return scope.withLock(PLANS_FILE, () => {
    const doc = loadPlans();
    const p = (doc.plans || []).find((x) => x.plan_id === id);
    const res = fn(p);
    savePlans(doc);
    return res;
  });
}
function getPlan(id) { return (loadPlans().plans || []).find((x) => x.plan_id === id) || null; }
function newPlanId() { return require('crypto').randomBytes(4).toString('hex'); }

const STATUS_LABEL = {
  pending: '⏳ En attente de confirmation',
  executing: '⚙️ Exécution…',
  done: '✅ Exécuté',
  partial: '⚠️ Exécuté partiellement',
  failed: '❌ Échec',
  refused: '⛔ Refusé à la re-vérification',
  cancelled: '🚫 Annulé',
  expired: '⌛ Expiré',
};

function renderPlan(p) {
  const lines = [];
  lines.push(`📋 **Plan d'action \`${p.plan_id}\`** — demandé par <@${p.requester_id}>`);
  lines.push(`${STATUS_LABEL[p.status] || p.status}${p.status === 'pending' ? ` · expire <t:${Math.floor(p.expires_at / 1000)}:R>` : ''}`);
  lines.push('Requêtes Discord API à exécuter :');
  for (const [i, st] of p.steps.entries()) {
    const reqs = st.requests.map((r) => `\`${r.method} ${r.route}\` (${r.human})`).join(' puis ');
    const res = p.results ? p.results[i] : null;
    const mark = res ? (res.ok ? ' → ✅' : ` → ❌ ${clean(res.error, 120)}`) : '';
    lines.push(`${i + 1}. ${reqs}${mark}`);
  }
  if (p.status === 'pending') lines.push('Seul le demandeur peut confirmer. Rien ne sera fait sans clic sur **Confirmer**.');
  if (p.note) lines.push(`_${clean(p.note, 200)}_`);
  let out = sanitizeMassMentions(lines.join('\n'));
  if (out.length > 2000) out = `${out.slice(0, 1990)}…`;
  return out;
}

function planComponents(p, disabled) {
  return [{ type: 1, components: [
    { type: 2, style: 3, label: 'Confirmer', custom_id: `plan:confirm:${p.plan_id}`, disabled: Boolean(disabled) },
    { type: 2, style: 4, label: 'Annuler', custom_id: `plan:cancel:${p.plan_id}`, disabled: Boolean(disabled) },
  ] }];
}

async function editPlanMessage(p) {
  if (!p.plan_message_id) return;
  await api('PATCH', `/channels/${p.channel_id}/messages/${p.plan_message_id}`, {
    body: { content: renderPlan(p), components: planComponents(p, p.status !== 'pending'), allowed_mentions: allowedMentions() },
  });
}

/**
 * act.sh entry point for mutating actions. Verifies the trigger + requester,
 * validates every action, stores a pending plan and posts it with buttons.
 * Never executes the actions.
 */
async function createPlan({ actions, channelId, messageId, claimedAuthor, dryRun }) {
  resetCache();
  const auth = await verifyRequester({ channelId, messageId, claimedAuthor, dryRun });
  if (auth.refuse) { modLog(`plan refused requester=${auth.realAuthor} claimed=${claimedAuthor || '-'} trigger=${messageId} ${auth.refuse}${dryRun ? ' (dry-run)' : ''}`); return { ok: false, error: `refused: ${auth.refuse}` }; }
  let steps;
  try { steps = await validateBatch(actions, auth.realAuthor, auth.isCreator); } catch (e) {
    modLog(`plan refused requester=${auth.realAuthor} trigger=${messageId} ${e.message}${dryRun ? ' (dry-run)' : ''}`);
    return { ok: false, error: e.message };
  }
  const now = Date.now();
  const plan = {
    plan_id: newPlanId(), requester_id: auth.realAuthor, guild_id: GUILD_ID, channel_id: channelId,
    source_message_id: messageId, actions: steps.map((s) => s.args), steps: steps.map(({ type, requests, need, permCh }) => ({ type, requests, need: need.map((g) => g.map(String)), perm_channel: permCh })),
    created_at: now, expires_at: now + PLAN_TTL_MS, status: 'pending', plan_message_id: null, results: null,
  };
  if (dryRun) {
    console.log(`dry-run plan (not stored, not posted):\n${renderPlan(plan)}`);
    modLog(`plan dry-run ${plan.plan_id} requester=${plan.requester_id} trigger=${messageId} actions=${plan.steps.map((s) => s.type).join(',')}`);
    return { ok: true, dryRun: true, plan_id: plan.plan_id, status: 'pending', plan };
  }
  scope.withLock(PLANS_FILE, () => { const doc = loadPlans(); doc.plans = doc.plans || []; doc.plans.push(plan); savePlans(doc); });
  markConsumed(messageId);
  const posted = await api('POST', `/channels/${channelId}/messages`, {
    body: { content: renderPlan(plan), components: planComponents(plan, false), allowed_mentions: allowedMentions(), message_reference: { message_id: messageId, channel_id: channelId, fail_if_not_exists: false } },
  });
  const pmid = posted.data?.id || null;
  updatePlan(plan.plan_id, (p) => { if (p) p.plan_message_id = pmid; });
  modLog(`plan created ${plan.plan_id} requester=${plan.requester_id} channel=${channelId} trigger=${messageId} plan_msg=${pmid} actions=${plan.steps.map((s) => s.type).join(',')}`);
  return { ok: true, plan_id: plan.plan_id, plan_message_id: pmid, status: 'pending', expires_at: new Date(plan.expires_at).toISOString() };
}

/**
 * Called by bridge.js on a button click (never by the AI). clickerId comes
 * from the Discord interaction. Returns { ok, ephemeral?, plan? }.
 */
function claimPlan(planId, clickerId, messageId, decision) {
  return updatePlan(planId, (p) => {
    if (!p) return { ok: false, ephemeral: 'Plan introuvable.' };
    if (messageId && p.plan_message_id && p.plan_message_id !== messageId) return { ok: false, ephemeral: 'Ce bouton ne correspond pas à ce plan.' };
    if (clickerId !== p.requester_id) return { ok: false, ephemeral: 'Seul le demandeur de ce plan peut le confirmer ou l\'annuler.', foreign: true };
    if (p.status !== 'pending') return { ok: false, ephemeral: `Plan déjà traité (${p.status}).` };
    if (Date.now() > p.expires_at) { p.status = 'expired'; return { ok: false, ephemeral: 'Plan expiré (10 min). Redemande l\'action.', plan: { ...p }, expired: true }; }
    p.status = decision === 'confirm' ? 'executing' : 'cancelled';
    p.decided_at = Date.now(); p.decided_by = clickerId;
    return { ok: true, plan: JSON.parse(JSON.stringify(p)) };
  });
}

async function cancelPlan(planId, clickerId, messageId) {
  const c = claimPlan(planId, clickerId, messageId, 'cancel');
  if (!c.ok) {
    modLog(`plan click refused ${planId} clicker=${clickerId} action=cancel ${c.ephemeral}`);
    if (c.expired && c.plan) await editPlanMessage(c.plan).catch(() => {});
    return c;
  }
  modLog(`plan cancelled ${planId} by=${clickerId}`);
  await editPlanMessage(c.plan);
  return c;
}

async function executePlan(planId, clickerId, messageId, { dryRun = false } = {}) {
  const c = claimPlan(planId, clickerId, messageId, 'confirm');
  if (!c.ok) {
    modLog(`plan click refused ${planId} clicker=${clickerId} action=confirm ${c.ephemeral}`);
    if (c.expired && c.plan) await editPlanMessage(c.plan).catch(() => {});
    return c;
  }
  const p = c.plan;
  resetCache();
  // Re-verify deterministically with fresh Discord data before running anything.
  let steps;
  try {
    steps = await validateBatch(p.actions, p.requester_id, p.requester_id === CREATOR_ID);
  } catch (e) {
    p.status = 'refused'; p.note = e.message;
    updatePlan(planId, (x) => { if (x) { x.status = p.status; x.note = p.note; } });
    modLog(`plan re-verify refused ${planId} requester=${p.requester_id} ${e.message}`);
    await editPlanMessage(p).catch((err) => modLog(`plan edit failed ${planId} ${err.message}`));
    return { ok: false, plan: p, ephemeral: `Refusé à la re-vérification : ${e.message}` };
  }
  modLog(`plan confirmed ${planId} by=${clickerId} executing ${steps.length} action(s)${dryRun ? ' (dry-run)' : ''}`);
  const results = [];
  for (const [i, st] of steps.entries()) {
    const short = clean(st.args.reason || '', 120);
    const ctx = { dryRun, reason: `cûm slayer plan ${planId} (par ${p.requester_id})${short ? `: ${short}` : ''}` };
    try {
      const res = await handlers[st.type](st.args || {}, ctx);
      results.push({ ok: true, result: res });
      modLog(`ok plan=${planId} action#${i} ${st.type} requester=${p.requester_id} ${JSON.stringify(res).slice(0, 200)}${dryRun ? ' (dry-run)' : ''}`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      results.push({ ok: false, error: msg });
      modLog(`fail plan=${planId} action#${i} ${st.type} requester=${p.requester_id} ${msg}${dryRun ? ' (dry-run)' : ''}`);
    }
  }
  const okN = results.filter((r) => r.ok).length;
  p.results = results;
  p.status = okN === results.length ? 'done' : okN === 0 ? 'failed' : 'partial';
  p.executed_at = Date.now();
  updatePlan(planId, (x) => { if (x) { x.status = p.status; x.results = results; x.executed_at = p.executed_at; } });
  if (!dryRun) await editPlanMessage(p).catch((err) => modLog(`plan edit failed ${planId} ${err.message}`));
  return { ok: true, plan: p };
}

module.exports = {
  runActions, handlers, classify, READ_ACTIONS, GUILD_ID, CREATOR_ID,
  createPlan, executePlan, cancelPlan, prepare, validateBatch, renderPlan, planComponents, editPlanMessage,
  getPlan, updatePlan, resetCache, verifyRequester, PLANS_FILE,
  _internal: { guild, roles, member, channel, api },
};

// CLI: read helpers only. mod.sh <list_roles|list_channels|list_members|member_info|list_bans|audit_log|list_emojis> ['{"json":"args"}']
if (require.main === module) {
  (async () => {
    const type = process.argv[2];
    if (!type || !READ_ACTIONS.has(type)) {
      console.error(`Usage: mod.sh <${[...READ_ACTIONS].join('|')}> ['{json args}']  (mutating actions only via act.sh)`);
      process.exit(2);
    }
    let args = {};
    if (process.argv[3]) args = JSON.parse(process.argv[3]);
    const res = await handlers[type](args, { dryRun: true });
    console.log(JSON.stringify(res));
  })().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
