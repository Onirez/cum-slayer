'use strict';
// Offline tests for /stats: live aggregates, lifetime counters, PNG render, render lock,
// and unregistering the retired /classement. No Discord, no Fly.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
const dataDir = path.join(tmp, 'data');
const usersDir = path.join(dataDir, 'users');
fs.mkdirSync(usersDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
process.env.LIFETIME_FILE = path.join(dataDir, 'lifetime.json');
process.env.USERMEM_DIR = usersDir;

const root = path.join(__dirname, '..');
const req = (name) => (fs.existsSync(path.join(root, `${name}.js`)) ? require(`../${name}`) : require(`../src/${name}`));
const compute = req('stats_compute');
const render = req('stats_render');
const lifetime = req('lifetime');
const slash = req('slash');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const SELF = '1574150367325855856';
const A = '111111111111111111';
const B = '222222222222222222';
const BOT = '444444444444444444';
// 2026-11-23 14:00 Paris = 13:00 UTC
const NOW = Date.UTC(2026, 10, 23, 13, 0, 0);
const H = 3600 * 1000;

function write(id, entries) {
  fs.writeFileSync(path.join(usersDir, `${id}.log.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

write(A, [
  { m: 'a1', t: NOW - 1 * H, ch: '10', cn: '🎯┃agent-2', n: 'Alice', c: 'salut ❤❤❤' },
  { m: 'a2', t: NOW - 2 * H, ch: '10', cn: '🎯┃agent-2', n: 'Alice', c: 'réponse au bot', r: 's1', ru: SELF },
  { m: 'a3', t: NOW - 26 * H, ch: '20', cn: '🖍️┃blabla', n: 'Alice', c: 'photo [2 pièce(s) jointe(s)]' },
]);
write(B, [
  { m: 'b1', t: NOW - 3 * H, ch: '20', cn: '🖍️┃blabla', n: 'Bob', c: 'x'.repeat(500) },
  { m: 'b2', t: NOW - 4 * H, ch: '20', cn: '🖍️┃blabla', n: 'Bob', c: 'hors fenêtre de réponse', r: 's1' },
]);
write(BOT, [
  { m: 'o1', t: NOW - 5 * H, ch: '10', cn: '🎯┃agent-2', n: 'Robot', b: true, c: 'beep', ru: SELF },
]);
write(SELF, [
  { m: 's1', t: NOW - 6 * H, ch: '10', cn: '🎯┃agent-2', n: 'cûm slayer', b: true },
]);
fs.writeFileSync(path.join(usersDir, `${A}.notes.json`), JSON.stringify({ userId: A, notes: [{ id: 1, text: 'n', at: NOW }] }));
fs.writeFileSync(path.join(dataDir, 'memory', `${A}.json`), JSON.stringify({ userId: A, memoryText: 'x' }));
fs.writeFileSync(path.join(dataDir, 'triggers.json'), JSON.stringify({ triggers: [
  { trigger: 'mention', at: NOW - 2 * H },
  { trigger: 'mention', at: NOW - 1 * H },
  { trigger: 'follow', at: NOW - 30 * 60 * 1000 },
  { trigger: 'reply_to_bot', at: NOW - 10 * 60 * 1000 },
] }));

// --- compute ---
const s = compute.computeStats({ usersDir, dataDir, selfId: SELF, now: NOW });
ok(s.messages === 7 && s.users === 4, 'counts every stored message and member log');
ok(s.humanUsers === 2 && s.botUsers === 2 && s.humanMsgs === 5 && s.botMsgs === 2, 'humans vs bots split (self counts as a bot)');
ok(s.topTalkers[0].id === A && s.topTalkers[0].count === 3, 'top talker is Alice');
ok(s.topTalkers.find((r) => r.id === BOT).bot === true, 'bots are marked in talkers');
ok(s.topChannels[0].name === 'agent-2' && s.topChannels[0].count === 4, 'channel names lose emoji and separator');
ok(s.hours[14] === 0 && s.hours[13] === 1, 'hours use Europe/Paris (13 h for NOW-1h)');
ok(s.last7.length === 7 && s.last7[6].date === '2026-11-23' && s.last7[6].count === 6 && s.last7[5].count === 1, 'last 7 days end on the newest Paris day');
ok(s.repliesToBot.total === 3, 'replies via ru or r to a stored bot message id');
ok(s.repliesToBot.people[0].id === A && s.repliesToBot.people[0].count === 1, 'reply leader computed');
ok(s.attachments.messages === 1 && s.attachments.units === 2, 'attachment annotation counted');
ok(s.length.atOrOver500 === 1, 'messages at the 500-char store cap are counted');
ok(s.hearts.total === 3 && s.hearts.maxOne === 3 && s.hearts.author === 'Alice', 'hearts counted without quoting content');
ok(s.triggers.recorded === 4 && s.triggers.kinds.mention === 2, 'recent triggers by kind');
ok(s.triggers.list.some((t) => t.type === 'reply' && t.count === 1), 'reply_to_bot is labelled reply');
ok(s.notes === 1 && s.memoryFiles === 1, 'notes and memory file counts');
ok(s.self.messages === 1 && s.self.channels[0].name === 'agent-2', 'bot self stats');
ok(/Europe\/Paris$/.test(s.generatedLabel), 'snapshot label is in Europe/Paris');
ok(compute.frNum(12901) === '12 901', 'French thousand separator');

const empty = compute.computeStats({ usersDir: path.join(tmp, 'nope'), dataDir: path.join(tmp, 'nope'), selfId: SELF, now: NOW });
ok(empty.messages === 0 && empty.topTalkers.length === 0 && empty.triggers.recorded === 0, 'empty data does not crash');

// --- lifetime ---
ok(!lifetime.hasData(lifetime.load()), 'lifetime starts empty');
lifetime.bumpTrigger('mention');
lifetime.bumpTrigger('mention');
lifetime.bumpTrigger('follow');
lifetime.bumpMedia({ images: 2, videos: 1 });
lifetime.bumpMedia({ images: 0, videos: 0 });
lifetime.bumpStats();
const life = lifetime.load();
ok(life.triggers.mention === 2 && life.triggers.follow === 1, 'lifetime counts triggers by type');
ok(life.images === 2 && life.videos === 1, 'lifetime counts images and videos separately');
ok(life.stats === 1 && life.startedAt > 0, 'lifetime counts /stats and records a start time');
ok(!('fiche' in life) && !('classement' in life), 'no /fiche or /classement counters');
fs.writeFileSync(process.env.LIFETIME_FILE, '{broken');
ok(lifetime.load().images === 0, 'corrupt lifetime file falls back to zeros');

// --- render ---
(async () => {
  const svg = render.buildSvg({ ...s, lifetime: null });
  ok(svg.width === 1600 && svg.height > 2000 && /Top 10 bavards/.test(svg.svg), 'SVG layout has the expected panels');
  ok(!/Compteurs all-time/.test(svg.svg), 'no lifetime panel without data');
  const svgLife = render.buildSvg({ ...s, lifetime: life });
  ok(/Compteurs all-time/.test(svgLife.svg) && /Images/.test(svgLife.svg), 'lifetime panel shows when counters exist');
  ok(!svg.svg.includes('<script') && !/salut ❤/.test(svg.svg), 'SVG has no script and no message bodies');
  ok(render.fontFiles().length >= 2, 'bundled fonts are found');

  const t0 = Date.now();
  const out = await render.renderFresh({ usersDir, dataDir, triggersFile: path.join(dataDir, 'triggers.json'), selfId: SELF, now: NOW, lifetime: null });
  const ms = Date.now() - t0;
  const sig = out.buffer.subarray(0, 8).toString('hex');
  ok(sig === '89504e470d0a1a0a' && out.bytes > 10_000, `renders a PNG (${out.bytes} bytes, ${ms} ms)`);
  ok(out.width === 1600, 'PNG is 1600 px wide');

  // Fresh each call: a new message shows up in the next render.
  fs.appendFileSync(path.join(usersDir, `${B}.log.jsonl`), `${JSON.stringify({ m: 'b3', t: NOW - 60_000, ch: '20', cn: 'blabla', n: 'Bob', c: 'nouveau' })}\n`);
  const again = await render.renderFresh({ usersDir, dataDir, selfId: SELF, now: NOW, lifetime: null });
  ok(again.stats.messages === 8, 'no cache: the next render sees new data');

  // Lock serializes renders.
  let active = 0;
  let maxActive = 0;
  const job = () => render.withRenderLock(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
  });
  await Promise.all([job(), job(), job()]);
  ok(maxActive === 1, 'render lock allows one render at a time');
  await render.withRenderLock(async () => { throw new Error('boom'); }).catch(() => {});
  let ran = false;
  await render.withRenderLock(async () => { ran = true; });
  ok(ran, 'a failed render does not jam the lock');

  // --- retired /classement unregister ---
  const deleted = [];
  const fake = {
    fetch: async () => new Map([
      ['1', { id: '1', name: 'classement' }],
      ['2', { id: '2', name: 'fiche' }],
      ['3', { id: '3', name: 'stats' }],
    ]),
    delete: async (id, guildId) => { deleted.push(`${guildId}:${id}`); },
  };
  const res = await slash.removeGuildCommands({ applicationCommands: fake, guildIds: ['99'], names: slash.RETIRED_COMMANDS });
  ok(res.length === 1 && deleted.join(',') === '99:1', 'only /classement is unregistered');

  console.log(`${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
