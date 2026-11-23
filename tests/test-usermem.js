'use strict';
// Offline tests for per-user memory. No Discord, no Fly. Uses a temp dir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usermem-'));
process.env.USERMEM_DIR = path.join(tmp, 'users');
process.env.USERMEM_KEEP = '40';
delete process.env.ACT_REMOTE_URL;
const root = path.join(__dirname, '..');
const src = (name) => (fs.existsSync(path.join(root, name)) ? path.join(root, name) : path.join(root, 'src', name));
const um = require(src('usermem.js'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const U = '111111111111111111';
const V = '222222222222222222';
const CLI = src('user.js');
const cli = (...a) => {
  const r = spawnSync(process.execPath, [CLI, ...a], { env: process.env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
};

function fakeMessage(i, { author = U, guild = '1095123126746099834', content = `msg ${i}`, bot = false } = {}) {
  return {
    id: String(9000000000000000 + i), guildId: guild, channelId: '333333333333333333', channel: { name: 'blabla' },
    createdTimestamp: 1763856000000 + i * 1000, cleanContent: content, content, embeds: [], attachments: { size: 0 },
    reference: i % 5 === 0 ? { messageId: '444444444444444444' } : null,
    mentions: { repliedUser: i % 5 === 0 ? { id: V } : null },
    member: { displayName: 'Testeur' }, author: { id: author, bot, username: 'testeur' },
  };
}

(async () => {
  // logging + cap/compaction
  for (let i = 1; i <= 120; i++) um.recordMessage(fakeMessage(i));
  await um.flush();
  const log = um.readLog(U);
  ok(log.length <= 50 && log.length >= 40, `log bounded (${log.length} lines, keep=40)`);
  ok(log[log.length - 1].c === 'msg 120', 'newest message kept last');
  ok(log.some((e) => e.ru === V), 'reply-to user recorded');
  ok(!(await um.recordMessage({ ...fakeMessage(500), guildId: null })), 'DMs are never logged');
  const SELF_BOT = '999999999999999999';
  ok(await um.recordMessage(fakeMessage(501, { author: SELF_BOT, content: 'secret bot reply with lots of text', bot: true }), { selfId: SELF_BOT }), 'own bot guild messages are counted');
  await um.flush();
  const selfLog = um.readLog(SELF_BOT);
  ok(selfLog.length === 1 && selfLog[0].b === 1 && !selfLog[0].c && !selfLog[0].r && !selfLog[0].ru, 'self entries are light: bot flag, no content');
  ok(!(await um.recordMessage({ ...fakeMessage(502, { author: SELF_BOT, bot: true }), guildId: null }, { selfId: SELF_BOT })), 'own bot DMs are never logged');
  const CUM = '1574150367325855856';
  const noteBot = um.addNote(CUM, '111111111111111111', 'une note sur le bot');
  ok(noteBot && noteBot.saved === false && /no AI notes/.test(noteBot.reason), 'AI notes on the bot itself are refused');
  ok(!require('fs').existsSync(um.notesPath(CUM)), 'refused bot note does not create a notes file');

  // truncation + token scrub
  const fakeToken = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`;
  await um.recordMessage(fakeMessage(121, { content: `voilà ${fakeToken} ${'x'.repeat(900)}` }));
  await um.flush();
  const last = um.readLog(U).pop();
  ok(last.c.length <= um.CONTENT_MAX, 'content truncated to 500 chars');
  ok(!last.c.includes(fakeToken) && last.c.includes('[token masqué]'), 'token-like strings scrubbed');

  // context block
  const ctx = um.contextFor(U, { limit: 15, excludeId: last.m });
  ok(ctx.recent.length === 15 && !ctx.recent.some((r) => r.c.includes('token')), 'context: 15 recent, current message excluded');
  ok(ctx.name === 'Testeur' && ctx.stats.logged > 0, 'context: name + stats');
  ok(JSON.stringify(ctx).length < 8000, `context compact (${JSON.stringify(ctx).length} bytes)`);

  // notes via CLI
  let r = cli('note', U, V, 'fan de PSG, surnommé "le zgeg"');
  ok(r.code === 0 && r.json.saved && r.json.note.by === V, 'note saved with attribution');
  r = cli('note', U, U, 'son mail est test@example.com');
  ok(r.json && r.json.saved === false && /e-mail/.test(r.json.reason), 'email refused in notes');
  r = cli('note', U, U, 'habite au 12 rue de la Paix');
  ok(r.json && r.json.saved === false, 'street address refused');
  r = cli('note', U, U, 'appelle-moi au 06 12 34 56 78');
  ok(r.json && r.json.saved === false, 'phone refused');
  r = cli('note', U, U, 'x'.repeat(250));
  ok(r.code === 2, 'over-long note rejected');
  r = cli('note', U, U, 'déteste les lundis', '--dry-run');
  ok(r.json && r.json.dryRun && !um.readNotes(U).notes.some((n) => n.text.includes('lundis')), 'dry-run note does not write');
  r = cli('get', U, '5');
  ok(r.code === 0 && r.json.notes.length === 1 && r.json.recent.length === 5, 'get returns notes + n messages');
  r = cli('history', U, '100', '--search', 'msg 11');
  ok(r.code === 0 && r.json.items.every((i) => i.c.includes('msg 11')), 'history search filter');
  r = cli('unnote', U, '1');
  ok(r.json && r.json.removed, 'unnote removes note');
  r = cli('note', U, U, 'note gardée');
  r = cli('list');
  ok(r.json && r.json.users.some((u) => u.id === U), 'list shows user');

  // merge (backfill) dedupes
  const before = um.readLog(U).length;
  const dup = um.readLog(U).slice(-3);
  const older = um.makeEntry({ messageId: '1', channelId: '3', timestamp: 1, content: 'vieux' });
  await um.mergeEntries(V, [older, older]);
  await um.mergeEntries(U, dup);
  ok(um.readLog(U).length === Math.min(before, 40), 'merge dedupes by message id');
  ok(um.readLog(V).length === 1, 'merge creates new user log');

  // opt-out + forget
  r = cli('optout', V);
  um.loadOptoutFresh();
  ok(!(await um.recordMessage(fakeMessage(700, { author: V }))), 'opted-out user not logged');
  cli('optin', V);
  r = cli('forget', U, 'all', '--dry-run');
  ok(r.json.dryRun && fs.existsSync(um.logPath(U)), 'forget dry-run keeps files');
  r = cli('forget', U);
  ok(r.code === 0 && !fs.existsSync(um.logPath(U)) && !fs.existsSync(um.notesPath(U)), 'forget deletes history + notes');
  r = cli('get', 'abc');
  ok(r.code === 2, 'invalid id rejected');

  // act.js user_notes (dry-run + real, no Discord call since reply/react are null)
  const ACT = src('act.js');
  const actRun = (body, dry) => spawnSync(process.execPath, [ACT, ...(dry ? ['--dry-run'] : [])], { input: JSON.stringify(body), env: process.env, encoding: 'utf8' });
  let a = actRun({ reply: null, react: null, user_notes: [{ subject: V, author: U, text: 'joue main Sett' }] }, true);
  ok(a.status === 0 && !um.readNotes(V).notes.length, 'act user_notes dry-run writes nothing');
  a = actRun({ reply: null, react: null, user_notes: [{ subject: V, author: U, text: 'joue main Sett' }, { subject: V, author: U, text: 'ip 10.0.0.1' }] }, false);
  const ar = JSON.parse(a.stdout.trim().split('\n').pop());
  ok(a.status === 0 && ar.results.user_notes[0].saved && !ar.results.user_notes[1].saved, 'act user_notes saves valid, refuses sensitive');

  // throwback ("vieux message")
  const W = '333333333333333334';
  const now = Date.now();
  const old = [];
  for (let i = 0; i < 10; i++) old.push(um.makeEntry({ messageId: `7${i}`, channelId: '5', channelName: 'cs', timestamp: now - (10 - i) * 86400000, content: i % 2 ? 'https://example.com/lien' : `je jure que je vais passer global elite avant noël ${i}`, name: 'W' }));
  for (let i = 0; i < 15; i++) old.push(um.makeEntry({ messageId: `8${i}`, channelId: '5', channelName: 'cs', timestamp: now - 1000 * (15 - i), content: `message récent assez long pour compter ${i}`, name: 'W' }));
  await um.mergeEntries(W, old);
  ok(um.throwbackCandidates(W, { now }).length === 4, 'throwback candidates: >3 days old + substantive only (links excluded, recent 15 excluded)');
  ok(um.maybeThrowback(W, { now, rand: () => 0.99 }) === null, 'throwback is rare (roll miss -> null)');
  const tb = um.maybeThrowback(W, { now, rand: () => 0 });
  ok(tb && /global elite/.test(tb.c) && tb.ch === '#cs' && tb.t, 'throwback returns {t, ch, c} of an old message');
  ok(um.maybeThrowback(W, { now: now + 3600000, rand: () => 0 }) === null, 'throwback cooldown: not twice the same day');
  ok(fs.existsSync(path.join(process.env.USERMEM_DIR, '_throwback.json')), 'throwback cooldown persisted to disk');
  ok(um.maybeThrowback(W, { now: now + 21 * 3600000, rand: () => 0 }) !== null, 'throwback allowed again after cooldown');
  ok(um.maybeThrowback(V, { now, rand: () => 0, force: true }) === null, 'no throwback without old substantive messages');
  ok(!um.substantive('😂😂 🔥') && !um.substantive('https://x.y/z') && !um.substantive('mdr ok'), 'emoji/link/short messages are not substantive');

  // bridge wiring (static)
  const bridgeSrc = fs.readFileSync(src('bridge.js'), 'utf8');
  ok(/users: loadUserContext\(/.test(bridgeSrc) && /USERMEM_HINT/.test(bridgeSrc), 'payload carries users block with usage hint');
  ok(/if \(!isDm && USERMEM_ENABLED\)/.test(bridgeSrc), 'logging is guild-only');
  ok(/usermem self append failed/.test(bridgeSrc) && /author\.id === client\.user\.id/.test(bridgeSrc), 'own guild messages are counted, then the handler returns without triggering');
  ok(/trigger !== 'daily_roast'/.test(bridgeSrc) && /author\.throwback = \{ \.\.\.tb, hint: THROWBACK_HINT \}/.test(bridgeSrc), 'throwback wired (not on daily_roast, with hint)');
  const act = require(src('act_http.js'));
  ok(act.ALLOWED_TOOLS.user === 'user.sh', '/run allows the user tool');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
