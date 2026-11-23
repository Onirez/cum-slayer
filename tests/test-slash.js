'use strict';
// Offline tests for /classement, /fiche, and interaction follow-up. No Discord, no Fly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-'));
process.env.USERMEM_DIR = path.join(tmp, 'users');
process.env.SLASH_IX_FILE = path.join(tmp, 'slash-ix.json');
delete process.env.ACT_REMOTE_URL;

const root = path.join(__dirname, '..');
const um = fs.existsSync(path.join(root, 'usermem.js')) ? require('../usermem') : require('../src/usermem');
const slash = fs.existsSync(path.join(root, 'slash.js')) ? require('../slash') : require('../src/slash');
const actJs = fs.existsSync(path.join(root, 'act.js')) ? path.join(root, 'act.js') : path.join(root, 'src', 'act.js');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';
const BOT = '444444444444444444';
const OUT = '555555555555555555';
const SELF = '1574150367325855856';
const now = 1_700_000_000_000;

function add(id, { t, ch, cn, c, n, b } = {}) {
  const e = um.makeEntry({
    messageId: `${id}-${t}`,
    channelId: ch,
    channelName: cn,
    timestamp: t,
    content: c || 'hello',
    name: n,
    bot: Boolean(b),
  });
  fs.mkdirSync(um.usersDir(), { recursive: true });
  fs.appendFileSync(um.logPath(id), `${JSON.stringify(e)}\n`);
}

// --- command payloads ---
const classCmd = slash.classementPayload();
ok(classCmd.name === 'classement' && classCmd.type === 1 && classCmd.dm_permission === false, '/classement is a guild chat-input command');
ok(!classCmd.default_member_permissions, '/classement is visible to everyone (no admin permission bit)');
const periodOpt = (classCmd.options || []).find((o) => o.name === 'periode');
const salonOpt = (classCmd.options || []).find((o) => o.name === 'salon');
ok(periodOpt && periodOpt.type === 3 && periodOpt.required === false, 'periode is an optional string');
ok(periodOpt.choices.map((c) => c.value).join(',') === '7j,30j,tout', 'periode choices are 7j / 30j / tout');
ok(salonOpt && salonOpt.type === 7 && salonOpt.required === false, 'salon is an optional channel');

const ficheCmd = slash.fichePayload();
ok(ficheCmd.name === 'fiche' && ficheCmd.type === 1 && ficheCmd.dm_permission === false, '/fiche is a guild chat-input command');
ok(!ficheCmd.default_member_permissions, '/fiche is visible to everyone');
const membreOpt = (ficheCmd.options || []).find((o) => o.name === 'membre');
ok(membreOpt && membreOpt.type === 6 && membreOpt.required === true, 'membre is a required user option');

// --- leaderboard ---
add(A, { t: now - 2 * 3600 * 1000, ch: '10', cn: 'blabla', c: 'yo', n: 'Alice' });
add(A, { t: now - 3 * 3600 * 1000, ch: '10', cn: 'blabla', c: 'encore', n: 'Alice' });
add(A, { t: now - 4 * 3600 * 1000, ch: '20', cn: 'agent-3', c: 'tech', n: 'Alice' });
add(B, { t: now - 1 * 3600 * 1000, ch: '10', cn: 'blabla', c: 'salut', n: 'Bob' });
add(C, { t: now - 20 * 24 * 3600 * 1000, ch: '10', cn: 'blabla', c: 'vieux', n: 'Carole' }); // 20 days ago
add(BOT, { t: now - 1000, ch: '10', cn: 'blabla', c: 'beep', n: 'NotAHuman', b: true });
add(OUT, { t: now - 1000, ch: '10', cn: 'blabla', c: 'secret', n: 'Opted' });
add(SELF, { t: now - 1000, ch: '10', cn: 'blabla', c: 'moi', n: 'cûm slayer' });
um.setOptout(OUT, true);

const week = um.leaderboard({ period: '7j', now, selfId: SELF });
ok(week.period === '7j' && week.rows.length === 2, '7j leaderboard has two humans (bot, opt-out, self, old message excluded)');
ok(week.rows[0].id === A && week.rows[0].count === 3 && week.rows[0].name === 'Alice', 'Alice is first with 3 messages');
ok(week.rows[0].top_channel === '#blabla', 'top channel is the one with the most messages');
ok(week.rows[1].id === B && week.rows[1].count === 1, 'Bob is second');
ok(!week.rows.some((r) => r.id === BOT || r.id === OUT || r.id === SELF || r.id === C), 'skips bot, opted-out, self, and out-of-window users');

const month = um.leaderboard({ period: '30j', now, selfId: SELF });
ok(month.rows.length === 3 && month.rows.some((r) => r.id === C && r.count === 1), '30j includes Carole\'s 20-day-old message');

const all = um.leaderboard({ period: 'tout', now, selfId: SELF });
ok(all.rows.length === 3, 'tout includes the same humans as 30j here');

const chOnly = um.leaderboard({ period: '7j', channelId: '20', now, selfId: SELF });
ok(chOnly.rows.length === 1 && chOnly.rows[0].id === A && chOnly.rows[0].count === 1, 'salon filter counts only that channel');

const empty = um.leaderboard({ period: '7j', channelId: '999', now, selfId: SELF });
ok(empty.rows.length === 0, 'unknown salon yields an empty board');

// cap at 10
for (let i = 0; i < 12; i++) {
  const id = `81${String(i).padStart(16, '0')}`;
  add(id, { t: now - 1000, ch: '10', cn: 'blabla', c: 'x', n: `U${i}` });
}
const top = um.leaderboard({ period: '7j', now, selfId: SELF, limit: 10 });
ok(top.rows.length === 10, 'leaderboard is capped at 10');

const embed = slash.buildClassementEmbed({ period: '7j', rows: week.rows });
ok(embed.title && /parlent trop|bavard/i.test(embed.title) && /7 jours/.test(embed.title), 'classement embed has an arrogant period title');
ok(/Alice/.test(embed.description) && /\*\*1\.\*\*/.test(embed.description), 'embed lists ranks and names');
ok(!embed.description.includes('<@'), 'embed does not ping (no <@id> mentions)');
ok(embed.footer && /Aucune IA/.test(embed.footer.text), 'footer says no AI was used');
const emptyEmbed = slash.buildClassementEmbed({ period: '7j', rows: [] });
ok(/désert|Personne/i.test(emptyEmbed.description), 'empty board has a roast empty state');

// --- cooldowns ---
slash.resetLimitsForTests();
ok(slash.checkCooldown('classement', A, slash.CLASSEMENT_COOLDOWN_MS, now).ok, 'first /classement is allowed');
slash.markCooldown('classement', A, now);
ok(!slash.checkCooldown('classement', A, slash.CLASSEMENT_COOLDOWN_MS, now + 1_000).ok, 'same user is on a 30 s classement cooldown');
ok(slash.checkCooldown('classement', B, slash.CLASSEMENT_COOLDOWN_MS, now + 1_000).ok, 'another user is not blocked by the first cooldown');
ok(slash.checkCooldown('classement', A, slash.CLASSEMENT_COOLDOWN_MS, now + slash.CLASSEMENT_COOLDOWN_MS).ok, 'classement allowed again after 30 s');

ok(slash.checkCooldown('fiche', A, slash.FICHE_COOLDOWN_MS, now).ok, 'first /fiche is allowed');
slash.markCooldown('fiche', A, now);
ok(!slash.checkCooldown('fiche', A, slash.FICHE_COOLDOWN_MS, now + 59_000).ok, 'same user is on a 60 s fiche cooldown');
ok(slash.checkCooldown('fiche', A, slash.FICHE_COOLDOWN_MS, now + slash.FICHE_COOLDOWN_MS).ok, 'fiche allowed again after 60 s');

ok(slash.checkFicheHourly(now).ok, 'hourly fiche cap starts empty');
for (let i = 0; i < slash.FICHE_HOURLY_MAX; i++) slash.markFicheHourly(now + i);
ok(!slash.checkFicheHourly(now + 1_000).ok, '21st AI fiche in an hour is refused');
ok(slash.checkFicheHourly(now + slash.FICHE_HOURLY_MS + 2_000).ok, 'hourly cap rolls off after an hour');

// --- decideFiche ---
const ctxA = um.contextFor(A, { limit: 15, role: 'target' });
ok(ctxA.notes && ctxA.recent.length && ctxA.stats, 'target context has notes/stats/recent shape');
const dOk = slash.decideFiche({ target: { id: A, bot: false, username: 'alice' }, selfId: SELF, isOptedOut: (id) => um.isOptedOut(id), context: (id) => um.contextFor(id, { limit: 15, role: 'target' }) });
ok(dOk.ok && dOk.reason === 'ok', '/fiche proceeds when the target has public data');

const dOut = slash.decideFiche({ target: { id: OUT, bot: false }, selfId: SELF, isOptedOut: (id) => um.isOptedOut(id), context: (id) => um.contextFor(id) });
ok(!dOut.ok && dOut.reason === 'optout' && dOut.reply === slash.NO_DATA_REPLY, 'opted-out target is refused locally with the insignifiant line');

const ghost = '999999999999999999';
const dNone = slash.decideFiche({ target: { id: ghost, bot: false }, selfId: SELF, isOptedOut: () => false, context: () => ({ notes: [], recent: [], stats: null }) });
ok(!dNone.ok && dNone.reason === 'no_data' && dNone.reply === slash.NO_DATA_REPLY, 'target with no data is refused locally, no AI');

const dBot = slash.decideFiche({ target: { id: BOT, bot: true, username: 'rob' }, selfId: SELF, isOptedOut: () => false, context: () => ({ notes: ['x'], recent: ['y'], stats: { logged: 1 } }) });
ok(!dBot.ok && dBot.reason === 'bot' && dBot.reply === slash.BOT_REPLY, 'bot target is refused locally');

const dSelf = slash.decideFiche({ target: { id: SELF, bot: false }, selfId: SELF, isOptedOut: () => false, context: () => ({ notes: ['x'], recent: ['y'], stats: { logged: 1 } }) });
ok(!dSelf.ok && dSelf.reason === 'bot', 'the bot itself is not portraitured');

// --- payload: no token, expected fields ---
const SECRET = 'super-secret-interaction-token-do-not-leak';
const payload = slash.buildFichePayload({
  guildId: '1095123126746099834',
  channelId: '1574094942085586995',
  inAgents: true,
  requester: { id: B, username: 'bob', display_name: 'Bob', bot: false },
  target: { id: A, username: 'alice', display_name: 'Alice', bot: false },
  targetContext: ctxA,
  interactionId: '123456789012345678',
});
ok(payload.trigger === 'slash_fiche', 'payload trigger is slash_fiche');
ok(payload.author.id === B && payload.target.id === A, 'author is the requester, target is the subject');
ok(payload.users.author.id === A && payload.users.target.id === A, 'users.author and users.target are the subject\'s usermem block');
ok(Array.isArray(payload.users.author.notes) && Array.isArray(payload.users.author.recent) && payload.users.author.stats, 'target block has notes, stats, recent');
ok(payload.interaction && payload.interaction.id === '123456789012345678' && payload.interaction.command === 'fiche' && payload.interaction.token_held === true, 'interaction info is present without the token');
ok(!Object.prototype.hasOwnProperty.call(payload.interaction, 'token'), 'interaction.token is not a payload field');
ok(!slash.payloadContainsSecret(payload, SECRET), 'payload builder does not include a held token');
ok(payload.message_id === null, 'slash_fiche has no target message_id');
ok(/notes et messages publics/i.test(payload.users.usage), 'usage hint tells the routine to stay on public notes/messages');

// --- pending store: tokens on disk, never in logs ---
const saved = slash.savePending({
  id: '123456789012345678',
  applicationId: '1574150367325855856',
  token: SECRET,
  channelId: '1574094942085586995',
  guildId: '1095123126746099834',
  userId: B,
  now,
});
ok(saved.id === '123456789012345678', 'pending interaction is stored by id');
const rec = slash.getPending('123456789012345678', now + 1000);
ok(rec && rec.token === SECRET && rec.application_id === '1574150367325855856', 'getPending returns the stored token to the bridge (not to the routine)');
ok(!slash.getPending('nope', now), 'unknown id is not found');
ok(!slash.getPending('123456789012345678', now + 15 * 60 * 1000), 'expired interactions are purged');

slash.savePending({
  id: '111',
  applicationId: '1574150367325855856',
  token: SECRET,
  channelId: '1',
  userId: B,
  now,
});
ok(slash.deletePending('111') && !slash.getPending('111', now + 1), 'deletePending removes the record after a successful follow-up');

// File mode should be 0600 when written
slash.savePending({
  id: '222',
  applicationId: '1574150367325855856',
  token: SECRET,
  channelId: '1',
  userId: B,
  now,
});
const mode = fs.statSync(process.env.SLASH_IX_FILE).mode & 0o777;
ok(mode === 0o600, `slash-ix file is mode 0600 (got ${mode.toString(8)})`);

// --- act.sh follow-up dry-run must not print the token ---
slash.savePending({
  id: '999888777666555444',
  applicationId: '1574150367325855856',
  token: SECRET,
  channelId: '1574094942085586995',
  userId: B,
  now: Date.now(),
});
const ran = spawnSync(process.execPath, [actJs, '--dry-run'], {
  encoding: 'utf8',
  env: { ...process.env, DRY_RUN: '1' },
  input: JSON.stringify({
    channel_id: '1574094942085586995',
    message_id: null,
    interaction_id: '999888777666555444',
    reply: 'Portrait de test, zéro ping.',
    react: null,
    memory_append: [],
    skill_create: null,
  }),
});
const out = `${ran.stdout || ''}${ran.stderr || ''}`;
ok(ran.status === 0, `act.js --dry-run with interaction_id exits 0 (status=${ran.status}, err=${(ran.stderr || '').slice(0, 200)})`);
ok(/dry-run PATCH \/webhooks/.test(out) && /interaction-token/.test(out), 'dry-run describes a webhook edit without the raw token path');
ok(!out.includes(SECRET), 'act.js output never prints the interaction token');
ok(/Portrait de test/.test(out), 'dry-run still shows the fiche text');

// missing / expired interaction_id
const missing = spawnSync(process.execPath, [actJs, '--dry-run'], {
  encoding: 'utf8',
  env: { ...process.env, DRY_RUN: '1' },
  input: JSON.stringify({ interaction_id: '000', reply: 'nope', channel_id: '1', message_id: null }),
});
ok(missing.status !== 0 && /unknown or expired/i.test(`${missing.stderr || ''}${missing.stdout || ''}`), 'unknown interaction_id is refused');

// followUpFiche dry-run redacts
const fu = awaitOrNot();
async function awaitOrNot() { return true; }

(async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  await slash.followUpFiche({ applicationId: 'app', token: SECRET, content: 'Salut', dryRun: true });
  console.log = origLog;
  const printed = logs.join('\n');
  ok(/dry-run PATCH/.test(printed) && !printed.includes(SECRET), 'followUpFiche dry-run does not print the token');

  // usermem is not written by slash helpers (no recordMessage call path)
  const before = um.readLog(A).length;
  ok(before > 0, 'precondition: Alice already has log lines');
  // decide/build/classement do not append
  um.leaderboard({ period: '7j', now, selfId: SELF });
  slash.buildClassementEmbed({ period: '7j', rows: [] });
  slash.buildFichePayload({
    guildId: '1', channelId: '2', inAgents: false,
    requester: { id: B, username: 'b', display_name: 'b', bot: false },
    target: { id: A, username: 'a', display_name: 'a', bot: false },
    targetContext: ctxA,
    interactionId: '3',
  });
  ok(um.readLog(A).length === before, 'slash helpers do not append a usermem log line for the interaction');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
