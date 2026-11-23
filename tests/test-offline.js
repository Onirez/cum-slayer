'use strict';
// Offline unit tests: no Discord, no webhook, no network.
const scope = require('../src/scope');
const { basePermissions, channelPermissions, names, missing, P, isTimedOut } = require('../src/perms');
const lib = require('../src/lib');
const config = require('../src/config');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const CAT = config.AGENTS_CATEGORY_ID;
const A1 = config.CHANNELS.agent1;
const A2 = config.CHANNELS.agent2;
const A3 = config.CHANNELS.agent3;
const GEN = config.CHANNELS.general;
const RULES = config.CHANNELS.rules;
const VOICE = config.CHANNELS.voice;
const BOT = config.BOT_APP_ID;

const channels = new Map([
  [CAT, { id: CAT, type: 4, parent_id: null }],
  [A1, { id: A1, type: 0, parent_id: CAT }],
  [A2, { id: A2, type: 0, parent_id: CAT }],
  [A3, { id: A3, type: 0, parent_id: CAT }],
  [GEN, { id: GEN, type: 0, parent_id: '999' }],
  [RULES, { id: RULES, type: 0, parent_id: '999' }],
  [VOICE, { id: VOICE, type: 2, parent_id: '999' }],
]);
const lookup = (id) => channels.get(id) || null;

// --- isInAgents ---
ok(scope.isInAgents(CAT, lookup), 'category itself is in AGENTS');
ok(scope.isInAgents(A1, lookup), 'agent-1 is in AGENTS');
ok(scope.isInAgents(A2, lookup), 'agent-2 is in AGENTS');
ok(scope.isInAgents(A3, lookup), 'agent-3 is in AGENTS');
ok(!scope.isInAgents(GEN, lookup), 'general is NOT in AGENTS');
ok(!scope.isInAgents(RULES, lookup), 'rules channel is NOT in AGENTS');
ok(!scope.isInAgents(VOICE, lookup), 'voice channel is NOT in AGENTS');
ok(!scope.isInAgents('', lookup), 'empty id is not in AGENTS');
ok(!scope.isInAgents('missing', lookup), 'unknown id is not in AGENTS');

const thread = { id: 'thread1', type: 11, parent_id: A3 };
ok(scope.isInAgents('thread1', (id) => (id === 'thread1' ? thread : lookup(id))), 'thread under agent-3 is in AGENTS');
const outsideThread = { id: 'thread2', type: 11, parent_id: GEN };
ok(!scope.isInAgents('thread2', (id) => (id === 'thread2' ? outsideThread : lookup(id))), 'thread under general is NOT in AGENTS');

// --- mentions ---
ok(scope.hasExplicitMention(`yo <@${BOT}> cum`, BOT), 'token <@id> detected');
ok(scope.hasExplicitMention(`yo <@!${BOT}>`, BOT), 'token <@!id> detected');
ok(!scope.hasExplicitMention('yo slayer', BOT), 'plain name is not an explicit mention');
ok(!scope.hasExplicitMention('', BOT), 'empty content is not a mention');

// --- decideTrigger ---
const base = { isDm: false, inAgents: false, explicitMention: false, mentioned: false, named: false, replyToBot: false, keyword: false };
ok(scope.decideTrigger({ ...base, isDm: true }).trigger === 'dm', 'DM always triggers');
ok(scope.decideTrigger({ ...base, inAgents: true, mentioned: true }).trigger === 'mention', 'AGENTS mention');
ok(scope.decideTrigger({ ...base, inAgents: true, named: true }).trigger === 'name', 'AGENTS name/alias');
ok(scope.decideTrigger({ ...base, inAgents: true, keyword: true }).trigger === 'keyword', 'AGENTS keyword');
ok(scope.decideTrigger({ ...base, inAgents: true, replyToBot: true }).trigger === 'reply_to_bot', 'AGENTS reply to bot');
ok(scope.decideTrigger({ ...base, inAgents: true }).trigger === null, 'AGENTS with no signal does not trigger');
ok(scope.decideTrigger({ ...base, explicitMention: true }).trigger === 'mention', 'outside AGENTS, explicit @ triggers');
ok(scope.decideTrigger({ ...base, replyToBot: true }).trigger === 'reply_to_bot', 'outside AGENTS, reply to bot triggers (creator exception)');
ok(scope.decideTrigger({ ...base, named: true }).trigger === null, 'outside AGENTS, name alone does not trigger');
ok(scope.decideTrigger({ ...base, keyword: true }).trigger === null, 'outside AGENTS, keyword alone does not trigger');
ok(scope.decideTrigger({ ...base, named: true }).skipped === 'name', 'outside AGENTS, name is reported as skipped');
ok(scope.decideTrigger({ ...base, mentioned: true, explicitMention: false }).skipped === 'mention(no @ token)', 'mention without token is skipped outside AGENTS');

// --- BotLoopGuard ---
const g = new scope.BotLoopGuard({ maxPerWindow: 5, windowMs: 600_000, authorCooldownMs: 5_000 });
const now = 1_000_000;
ok(g.check('ch', 'botA', now).ok, 'first bot trigger allowed');
g.record('ch', 'botA', now);
ok(!g.check('ch', 'botA', now + 1000).ok, 'same bot within cooldown refused');
ok(g.check('ch', 'botB', now + 1000).ok, 'other bot not on cooldown');
for (let i = 1; i < 5; i++) g.record('ch', `bot${i}`, now + 10_000 * i);
ok(!g.check('ch', 'botZ', now + 60_000).ok, '6th bot-triggered reply in window refused');
g.noteHuman('ch');
ok(g.check('ch', 'botZ', now + 70_000).ok, 'human message resets the per-channel cap');

// --- perms ---
const guild = { id: 'g1', owner_id: 'owner1' };
const roles = [
  { id: 'g1', permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY) },
  { id: 'mod', permissions: String(P.KICK_MEMBERS | P.MANAGE_MESSAGES | P.VIEW_CHANNEL | P.SEND_MESSAGES), position: 5 },
  { id: 'admin', permissions: String(P.ADMINISTRATOR), position: 10 },
];
const owner = { user: { id: 'owner1' }, roles: [] };
ok(basePermissions(owner, guild, roles) === ((1n << 64n) - 1n), 'guild owner has all permissions');
const admin = { user: { id: 'u-admin' }, roles: ['admin'] };
ok(names(basePermissions(admin, guild, roles)).includes('ALL'), 'Administrator role has all permissions');
const mod = { user: { id: 'u-mod' }, roles: ['mod'] };
const modPerms = basePermissions(mod, guild, roles);
ok((modPerms & P.KICK_MEMBERS) === P.KICK_MEMBERS, 'mod has KICK_MEMBERS');
ok((modPerms & P.BAN_MEMBERS) !== P.BAN_MEMBERS, 'mod does not have BAN_MEMBERS');
ok(missing(modPerms, [[P.BAN_MEMBERS]]).includes('BAN_MEMBERS'), 'missing() reports BAN_MEMBERS');

const everyoneOnly = { user: { id: 'u- pleb'.replace(' ', '') }, roles: [] };
const chNoView = {
  permission_overwrites: [{ id: 'g1', type: 0, allow: '0', deny: String(P.VIEW_CHANNEL) }],
};
ok(channelPermissions(everyoneOnly, guild, roles, chNoView) === 0n, 'no VIEW_CHANNEL => no channel perms');

const timed = { user: { id: 'u-to' }, roles: ['mod'], communication_disabled_until: new Date(Date.now() + 60_000).toISOString() };
ok(isTimedOut(timed), 'member with future timeout is timed out');
const toPerms = basePermissions(timed, guild, roles);
ok((toPerms & P.KICK_MEMBERS) !== P.KICK_MEMBERS, 'timed-out member loses KICK_MEMBERS');
ok((toPerms & P.VIEW_CHANNEL) === P.VIEW_CHANNEL, 'timed-out member keeps VIEW_CHANNEL');

// --- lib ---
ok(lib.sanitizeMassMentions('hello @everyone and @here') === 'hello @{everyone} and @{here}', 'mass mentions are neutralized');
ok(lib.splitContent('a'.repeat(2001)).length === 2, 'content longer than 2000 is split');
ok(lib.splitContent('short').length === 1, 'short content is a single chunk');
ok(lib.encodeReactionEmoji('🔥') === encodeURIComponent('🔥'), 'unicode emoji is encoded');
ok(lib.encodeReactionEmoji('<:pepe:123>') === 'pepe:123', 'custom emoji is name:id');

// --- config ---
ok(config.BOT_APP_ID && /^\d+$/.test(config.BOT_APP_ID), 'BOT_APP_ID is numeric');
ok(config.CREATOR_ID && config.CREATOR_ID !== config.BOT_APP_ID, 'CREATOR_ID is set and distinct from the bot');
ok(config.AGENTS_CATEGORY_ID === CAT, 'AGENTS_CATEGORY_ID comes from config');
ok(Array.isArray(config.BOT_ALIASES) && config.BOT_ALIASES.includes('cûm slayer'), 'default aliases include cûm slayer');
ok(config.DATA_DIR.endsWith('/data') || config.DATA_DIR.endsWith('\\data'), 'DATA_DIR points at data/');
ok(typeof config.ROUTINE_WEBHOOK_URL === 'string', 'ROUTINE_WEBHOOK_URL getter is safe to read');
ok(typeof config.ROUTINE_WEBHOOK_KEY === 'string', 'ROUTINE_WEBHOOK_KEY getter is safe to read');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
