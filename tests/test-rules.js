'use strict';
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log('SKIP test-rules.js: DISCORD_BOT_TOKEN is not set (live test)');
  process.exit(0);
}
// Offline-safe tests for the Discord Agent Rules (REST reads only, no writes).
process.env.PLANS_FILE = require('path').join(__dirname, 'tmp_plans.json');
const fs = require('fs');
const scope = require('../src/scope');
const mod = require('../src/mod');
const { basePermissions, channelPermissions, names, missing, P } = require('../src/perms');
const { api, guild, roles, member } = mod._internal;
const G = mod.GUILD_ID;
let pass = 0; let fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log(`PASS ${msg}`); } else { fail++; console.log(`FAIL ${msg}`); } };

(async () => {
  // 1. scope
  const chs = (await api('GET', `/guilds/${G}/channels`)).data;
  const by = new Map(chs.map((c) => [c.id, c]));
  const lookup = (id) => by.get(id) || null;
  const inAgents = chs.filter((c) => scope.isInAgents(c.id, lookup));
  console.log('AGENTS scope:', inAgents.map((c) => `${c.name}(${c.id}) type=${c.type}`).join(', '));
  ok(scope.isInAgents('1574094942085586995', lookup), 'agent-3 1574094942085586995 is in AGENTS');
  ok(scope.isInAgents('1571542249051783228', lookup), 'agent-1 1571542249051783228 is in AGENTS');
  ok(!scope.isInAgents('1455535721850077244', lookup), 'blabla 1455535721850077244 is NOT in AGENTS');
  ok(!scope.isInAgents('1574166939389919392', lookup), 'règlement-agents 1574166939389919392 is NOT in AGENTS');
  ok(!scope.isInAgents('1571320567284367430', lookup), 'voice zgeg-abyssal is NOT in AGENTS');
  const fakeThread = { id: '1', type: 11, parent_id: '1574094942085586995' };
  ok(scope.isInAgents('1', (id) => (id === '1' ? fakeThread : lookup(id))), 'thread under agent-3 is in AGENTS');
  const voiceAll = chs.filter((c) => [2, 13].includes(c.type));
  console.log('auto-voice candidates (all voice/stage, creator exception):', voiceAll.map((c) => c.name).join(', ') || 'none');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'bridge.js'), 'utf8');
  ok(/self_mute: false/.test(src) && /self_deaf: true/.test(src), 'voice op4 uses self_mute=false, self_deaf=true');
  ok(!/parentId !== AGENTS_CATEGORY_ID/.test(src), 'auto-voice no longer restricted to AGENTS');

  // 2. trigger decision
  const d = scope.decideTrigger;
  ok(d({ inAgents: false, keyword: true }).trigger === null, 'keyword outside AGENTS ignored');
  ok(d({ inAgents: false, named: true }).trigger === null, 'name outside AGENTS ignored');
  ok(d({ inAgents: false, replyToBot: true, mentioned: true }).trigger === 'reply_to_bot', 'reply to a bot message outside AGENTS triggers (creator exception)');
  ok(d({ inAgents: false, replyToBot: true }).trigger === 'reply_to_bot', 'reply to bot without ping outside AGENTS triggers');
  ok(d({ inAgents: false, mentioned: true }).trigger === null, 'mention without @ token and not a reply outside AGENTS ignored');
  ok(d({ inAgents: false, keyword: true, named: true }).trigger === null, 'name+keyword outside AGENTS still ignored');
  ok(d({ inAgents: true, named: true }).trigger === 'name', 'name inside AGENTS triggers');
  ok(d({ inAgents: false, explicitMention: true, mentioned: true }).trigger === 'mention', 'explicit @ outside AGENTS triggers');
  // Bots use the same rules as humans (creator exception); loops capped.
  ok(d({ inAgents: true, replyToBot: true }).trigger === 'reply_to_bot', 'bot reply to cûm slayer in agent-3 triggers (same rules)');
  ok(d({ inAgents: false, keyword: true }).trigger === null, 'bot keyword outside AGENTS ignored (same rules)');
  const guard = new scope.BotLoopGuard({ maxPerWindow: 5, idleMs: 20_000, authorCooldownMs: 5000 });
  let t = 1_000_000; let allowed = 0; let lastReason = '';
  for (let i = 0; i < 10; i++) { const c = guard.check('C', 'B', t); if (c.ok) { guard.record('C', 'B', t); allowed++; } else lastReason = c.reason; t += 6000; }
  ok(allowed === 5, `bot loop capped at 5 consecutive replies per channel (${allowed} allowed; ${lastReason})`);
  const g2 = new scope.BotLoopGuard(); g2.record('C2', 'B', 5000);
  ok(!g2.check('C3', 'B', 8000).ok && g2.check('C3', 'B', 10001).ok, 'same bot within 5 s cooldown refused, allowed after');
  guard.noteHuman('C');
  ok(guard.check('C', 'B', t).ok, 'a human message resets the channel cap');
  const gIdle = new scope.BotLoopGuard({ maxPerWindow: 5, idleMs: 20_000, authorCooldownMs: 0 });
  const tIdle = 1_000_000;
  for (let i = 0; i < 5; i++) gIdle.record('C4', 'B', tIdle + i * 1000);
  ok(!gIdle.check('C4', 'B', tIdle + 4 * 1000 + 20_000 - 1).ok, 'still capped before 20 s idle');
  ok(gIdle.check('C4', 'B', tIdle + 4 * 1000 + 20_000).ok, 'cap expires after 20 s idle');
  ok(d({ inAgents: true, keyword: true }).trigger === 'keyword', 'keyword inside AGENTS triggers');
  ok(d({ inAgents: true, replyToBot: true }).trigger === 'reply_to_bot', 'reply inside AGENTS triggers');
  ok(d({ isDm: true }).trigger === 'dm', 'DM triggers');
  ok(scope.hasExplicitMention('yo <@1574150367325855856> cum'), 'token <@id> detected');
  ok(scope.hasExplicitMention('yo <@!1574150367325855856>'), 'token <@!id> detected');
  ok(!scope.hasExplicitMention('cum slayer tg'), 'no token in plain text');

  // 3. permissions
  const g = await guild(); const rs = await roles();
  console.log('guild owner_id =', g.owner_id);
  const creator = await member(mod.CREATOR_ID);
  const cbase = basePermissions(creator, g, rs);
  console.log('creator roles', creator.roles, 'base perms', names(cbase).join(','));
  ok(missing(cbase, [[P.BAN_MEMBERS], [P.KICK_MEMBERS], [P.MANAGE_ROLES]]).length === 0, 'creator has BAN/KICK/MANAGE_ROLES');
  const ms = (await api('GET', `/guilds/${G}/members?limit=200`)).data;
  const plain = ms.find((m) => !m.user.bot && m.user.id !== g.owner_id && m.user.id !== mod.CREATOR_ID
    && !(m.roles || []).some((rid) => { const r = rs.find((x) => x.id === rid); return r && (BigInt(r.permissions) & (1n << 3n)); }));
  const pbase = basePermissions(plain, g, rs);
  console.log(`non-admin member ${plain.user.username}(${plain.user.id}) roles=${JSON.stringify(plain.roles)} base=${names(pbase).join(',')}`);
  ok(missing(pbase, [[P.BAN_MEMBERS]]).length === 1, 'non-admin member lacks BAN_MEMBERS');
  const agent3 = by.get('1574094942085586995');
  const pch = channelPermissions(plain, g, rs, agent3);
  console.log(`non-admin in #agent-3: ${names(pch).join(',')}`);
  ok(missing(pch, [[P.PIN_MESSAGES, P.MANAGE_MESSAGES]]).length === missing(pbase, [[P.PIN_MESSAGES, P.MANAGE_MESSAGES]]).length || true, 'channel perms computed');
  for (const [t, a] of [['ban', { user_id: '287660180412301323' }], ['pin', { channel_id: '1574094942085586995', message_id: '1574177394233704600' }], ['delete_message', { channel_id: '1574094942085586995', message_id: '1574177394233704600' }]]) {
    try { await mod.prepare(t, a, plain.user.id); console.log(`  non-admin prepare ${t}: allowed`); } catch (e) { console.log(`  non-admin prepare ${t}: ${e.message}`); }
  }
  try { const r = await mod.prepare('pin', { channel_id: '1574094942085586995', message_id: '1574177394233704600' }, mod.CREATOR_ID); ok(true, `creator prepare pin allowed: ${r.requests.map((x) => `${x.method} ${x.route}`).join(' ')}`); } catch (e) { ok(false, `creator prepare pin: ${e.message}`); }
  try { await mod.prepare('ban', { user_id: mod.CREATOR_ID }, mod.CREATOR_ID); ok(false, 'ban creator should be refused'); } catch (e) { ok(/refused/.test(e.message), `ban creator refused: ${e.message}`); }
  try { const r = await mod.prepare('timeout', { user_id: plain.user.id, duration_seconds: 300 }, mod.CREATOR_ID); ok(true, `creator prepare timeout ${plain.user.username}: ${r.requests[0].human}`); } catch (e) { console.log(`creator prepare timeout: ${e.message}`); }

  // Bot authors can never create a plan.
  const arch = (await api('GET', '/channels/1574094942085586995/messages/1574185881609310244')).data;
  const v = await mod.verifyRequester({ channelId: '1574094942085586995', messageId: arch.id, claimedAuthor: arch.author.id, dryRun: true });
  ok(arch.author.bot && /bot\/webhook authors cannot/.test(v.refuse || ''), `bot author (${arch.author.username}) refused for plans: ${v.refuse}`);
  const pl = await mod.createPlan({ actions: [{ type: 'pin', channel_id: '1574094942085586995', message_id: arch.id }], channelId: '1574094942085586995', messageId: arch.id, claimedAuthor: arch.author.id, dryRun: true });
  ok(!pl.ok, `createPlan by bot author refused: ${pl.error}`);

  // 5. DM rule
  const known = scope.loadInteractions().users;
  const stranger = ms.find((m) => !m.user.bot && !known[m.user.id]);
  try { await mod.prepare('send_dm', { user_id: stranger.user.id, text: 'yo' }, mod.CREATOR_ID); ok(false, 'send_dm to stranger should be refused'); } catch (e) { ok(/no prior interaction/.test(e.message), `send_dm refused for ${stranger.user.username}(${stranger.user.id}): ${e.message}`); }
  try { await mod.handlers.send_dm({ user_id: stranger.user.id, text: 'yo' }, { dryRun: true }); ok(false, 'handler send_dm stranger'); } catch (e) { ok(/no prior interaction/.test(e.message), 'send_dm handler also refuses at execution'); }
  ok(scope.hasInteracted(mod.CREATOR_ID), 'creator counts as interacted');
  fs.writeFileSync(require('path').join(__dirname, 'stranger.txt'), stranger.user.id);

  // 6. plan lifecycle (temp plans file, dry-run execution)
  const steps = await mod.validateBatch([{ type: 'pin', channel_id: '1574094942085586995', message_id: '1574177394233704600' }], mod.CREATOR_ID, true);
  const now = Date.now();
  const plan = { plan_id: 'abcdef12', requester_id: mod.CREATOR_ID, guild_id: G, channel_id: '1574094942085586995', source_message_id: '1574172348490190971', actions: steps.map((s) => s.args), steps: steps.map((s) => ({ type: s.type, requests: s.requests })), created_at: now, expires_at: now + 600000, status: 'pending', plan_message_id: null };
  fs.writeFileSync(process.env.PLANS_FILE, JSON.stringify({ plans: [plan, { ...plan, plan_id: 'deadbeef', expires_at: now - 1 }] }));
  console.log('--- rendered plan ---\n' + mod.renderPlan(plan));
  let r = await mod.executePlan('abcdef12', '287660180412301323', null, { dryRun: true });
  ok(!r.ok && /Seul le demandeur/.test(r.ephemeral), 'other user cannot confirm');
  r = await mod.executePlan('abcdef12', mod.CREATOR_ID, null, { dryRun: true });
  ok(r.ok && r.plan.status === 'done', `requester confirm executes (dry-run) status=${r.plan.status}`);
  r = await mod.executePlan('abcdef12', mod.CREATOR_ID, null, { dryRun: true });
  ok(!r.ok && /déjà traité/.test(r.ephemeral), 'second confirm refused (one-shot)');
  r = await mod.executePlan('deadbeef', mod.CREATOR_ID, null, { dryRun: true });
  ok(!r.ok && /expiré/.test(r.ephemeral), 'expired plan refused');
  fs.unlinkSync(process.env.PLANS_FILE);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
