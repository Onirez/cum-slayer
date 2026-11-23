'use strict';

/**
 * Deterministic Discord permission computation (REST objects), following
 * https://discord.com/developers/docs/topics/permissions#permission-overwrites
 *  - guild owner => all; Administrator => all
 *  - base = @everyone role | member roles
 *  - channel: @everyone overwrite, then role overwrites (deny then allow),
 *    then member overwrite; threads use their parent channel's overwrites
 *  - no VIEW_CHANNEL in the channel => nothing
 *  - timed-out members keep only VIEW_CHANNEL + READ_MESSAGE_HISTORY
 */

const P = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MOVE_MEMBERS: 1n << 24n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_GUILD_EXPRESSIONS: 1n << 30n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS: 1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS: 1n << 40n,
  CREATE_GUILD_EXPRESSIONS: 1n << 43n,
  PIN_MESSAGES: 1n << 51n,
};
const ALL = (1n << 64n) - 1n;
const NAMES = Object.fromEntries(Object.entries(P).map(([k, v]) => [v.toString(), k]));

function big(v) { try { return BigInt(String(v ?? '0')); } catch { return 0n; } }

function isTimedOut(member, now = Date.now()) {
  const u = member?.communication_disabled_until;
  return Boolean(u && Date.parse(u) > now);
}

/** Guild-level permissions. guild: { id, owner_id }, roles: REST role list. */
function basePermissions(member, guild, roles) {
  if (!member) return 0n;
  const uid = member.user?.id;
  if (uid && uid === guild.owner_id) return ALL;
  const byId = new Map(roles.map((r) => [r.id, r]));
  let perms = big(byId.get(guild.id)?.permissions);
  for (const rid of member.roles || []) perms |= big(byId.get(rid)?.permissions);
  if ((perms & P.ADMINISTRATOR) === P.ADMINISTRATOR) return ALL;
  if (isTimedOut(member)) perms &= (P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  return perms;
}

/** Channel-level permissions. overwriteSource: the channel (or thread parent). */
function channelPermissions(member, guild, roles, overwriteSource) {
  const base = basePermissions(member, guild, roles);
  if (base === ALL) return ALL;
  let perms = base;
  const ows = overwriteSource?.permission_overwrites || [];
  const everyone = ows.find((o) => o.id === guild.id);
  if (everyone) { perms &= ~big(everyone.deny); perms |= big(everyone.allow); }
  let allow = 0n; let deny = 0n;
  const mroles = new Set(member.roles || []);
  for (const o of ows) {
    if (String(o.type) === '0' && o.id !== guild.id && mroles.has(o.id)) { allow |= big(o.allow); deny |= big(o.deny); }
  }
  perms &= ~deny; perms |= allow;
  const mo = ows.find((o) => String(o.type) === '1' && o.id === member.user?.id);
  if (mo) { perms &= ~big(mo.deny); perms |= big(mo.allow); }
  if ((perms & P.VIEW_CHANNEL) !== P.VIEW_CHANNEL) return 0n;
  if (isTimedOut(member)) perms &= (P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  return perms;
}

/** Highest role position (owner = Infinity). */
function highestPosition(member, guild, roles) {
  if (!member) return -1;
  if (member.user?.id === guild.owner_id) return Infinity;
  const byId = new Map(roles.map((r) => [r.id, r]));
  let pos = 0;
  for (const rid of member.roles || []) pos = Math.max(pos, byId.get(rid)?.position ?? 0);
  return pos;
}

/** need: array of groups; each group is an array of alternative bits. */
function missing(perms, need) {
  const out = [];
  for (const group of need) {
    if (!group.some((bit) => (perms & bit) === bit)) out.push(group.map((b) => NAMES[b.toString()] || b.toString()).join('|'));
  }
  return out;
}

function names(perms) {
  if (perms === ALL) return ['ALL'];
  return Object.entries(P).filter(([, v]) => (perms & v) === v).map(([k]) => k);
}

module.exports = { P, ALL, big, basePermissions, channelPermissions, highestPosition, missing, names, isTimedOut };
