'use strict';
// Offline tests for the read-only full-history counter. No Discord, no token, no usermem writes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'full-count-'));
const root = path.join(__dirname, '..');
const fc = fs.existsSync(path.join(root, 'full_count.js')) ? require('../full_count') : require('../src/full_count');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const TOKEN = 'TESTTOKEN_do_not_leak_abcdefghijklmnopqrstuvwxyz';
const GUILD = '1095123126746099834';

ok(fc.redact(`Authorization: Bot ${TOKEN} failed`, TOKEN).includes('[token]') && !fc.redact(`Bot ${TOKEN}`, TOKEN).includes(TOKEN), 'redact hides a bot token');
ok(fc.typeLabel(0) === 'texte' && fc.typeLabel(2) === 'salon vocal (chat)' && fc.typeLabel(15) === 'forum', 'channel type labels');
ok(fc.monthKey(Date.UTC(2026, 10, 23, 14, 0, 0)) === '2026-11', 'month key is Europe/Paris year-month');

const totals = fc.emptyTotals();
fc.addMessage(totals, { id: '1', timestamp: '2024-01-15T12:00:00.000Z', author: { id: 'A', username: 'alice', bot: false }, content: 'SECRET_BODY' });
fc.addMessage(totals, { id: '2', timestamp: '2026-11-23T12:00:00.000Z', author: { id: 'B', username: 'botty', bot: true } });
fc.addMessage(totals, { id: '3', timestamp: '2026-11-23T13:00:00.000Z', author: { id: 'A', global_name: 'Alice', bot: false } });
ok(totals.total === 3 && totals.humans === 2 && totals.bots === 1, 'humans vs bots split');
ok(totals.authors.get('A').count === 2 && totals.authors.get('A').name === 'Alice', 'per-author totals use the latest name');
ok(totals.months.get('2024-01') === 1 && totals.months.get('2026-11') === 2, 'per-month totals');
ok(!JSON.stringify([...totals.authors.values()]).includes('SECRET_BODY'), 'author aggregates do not keep message content');

// Fake Discord API
function snowflakeTime(id) { return new Date(Number(id)).toISOString(); }
const messages = {
  text1: [
    ...Array.from({ length: 100 }, (_, i) => ({
      id: String(1_700_000_000_000 + i),
      timestamp: snowflakeTime(1_700_000_000_000 + i),
      author: { id: 'A', username: 'alice', bot: false },
      content: `hidden-${i}`,
    })),
    { id: '1600000000000', timestamp: '2020-09-13T10:00:00.000Z', author: { id: 'A', username: 'alice', bot: false }, content: 'first' },
  ],
  voice1: [
    { id: '1700000000100', timestamp: '2023-11-23T10:00:00.000Z', author: { id: 'C', username: 'carla', bot: false } },
  ],
  locked: [{ id: 'x', content: 'should-not-be-counted' }],
  thread1: [
    { id: '1700000000200', timestamp: '2025-06-01T10:00:00.000Z', author: { id: 'B', username: 'botty', bot: true } },
  ],
  threadArch: [
    { id: '1500000000000', timestamp: '2017-07-14T10:00:00.000Z', author: { id: 'A', username: 'alice', bot: false } },
  ],
};

const calls = [];
function mockFetch(url, init) {
  const u = String(url);
  const auth = init && init.headers && init.headers.Authorization;
  calls.push({ u, hasToken: Boolean(auth && String(auth).includes(TOKEN)) });
  const path = u.replace(fc.API, '');
  const json = (status, data) => Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    json: async () => data,
  });
  if (path === `/guilds/${GUILD}`) return json(200, { id: GUILD, name: 'Le Royaume' });
  if (path === `/guilds/${GUILD}/channels`) {
    return json(200, [
      { id: 'text1', name: 'blabla', type: 0 },
      { id: 'ann1', name: 'annonces', type: 5 },
      { id: 'voice1', name: 'vocal', type: 2 },
      { id: 'forum1', name: 'ideas', type: 15 },
      { id: 'locked', name: 'secret', type: 0 },
      { id: 'cat', name: 'Category', type: 4 },
    ]);
  }
  if (path === `/guilds/${GUILD}/threads/active`) {
    return json(200, { threads: [{ id: 'thread1', name: 'live-thread', type: 11, parent_id: 'text1' }], has_more: false });
  }
  if (path.startsWith('/channels/forum1/threads/archived/public')) {
    return json(200, { threads: [{ id: 'threadArch', name: 'old-post', type: 11, parent_id: 'forum1', thread_metadata: { archive_timestamp: '2020-01-01T00:00:00.000Z' } }], has_more: false });
  }
  if (path.startsWith('/channels/') && path.includes('threads/archived')) {
    return json(200, { threads: [], has_more: false });
  }
  const m = path.match(/^\/channels\/(\w+)\/messages\?(.*)$/);
  if (m) {
    const id = m[1];
    if (id === 'locked') return json(403, { message: 'Missing Access', code: 50001 });
    if (id === 'forum1') return json(400, { message: 'bad' });
    const params = new URLSearchParams(m[2]);
    const before = params.get('before');
    const all = messages[id] || [];
    const list = before ? all.filter((msg) => msg.id < before) : all.slice();
    // already oldest-first in some fixtures; API returns newest first. Sort desc by id.
    list.sort((a, b) => (a.id < b.id ? 1 : -1));
    return json(200, list.slice(0, 100));
  }
  return json(404, { message: 'no' });
}

(async () => {
  const outFile = path.join(tmp, 'full_count.json');
  const summary = await fc.runAndSave({
    guildId: GUILD,
    outFile,
    fresh: true,
    paceMs: 0,
    scanner: fc.createScanner({ token: TOKEN, fetch: mockFetch, sleep: async () => {}, now: () => 1_700_000_000_000, log: () => {}, paceMs: 0 }),
  });

  ok(summary.guildName === 'Le Royaume' && summary.guildId === GUILD, 'guild identity recorded');
  ok(summary.total === 104, `grand total is every reachable message (got ${summary.total})`);
  // text1: 101, voice1: 1, thread1: 1, threadArch: 1, locked: 0, forum parent skipped, ann1 empty
  ok(summary.humans === 103 && summary.bots === 1, `humans vs bots (h=${summary.humans} b=${summary.bots})`);
  const byName = Object.fromEntries(summary.channels.map((c) => [c.name, c]));
  ok(byName.blabla.count === 101 && byName.vocal.count === 1, 'per-channel counts include text and voice chat');
  ok(byName['live-thread'].count === 1 && byName['old-post'].count === 1 && byName['old-post'].thread, 'active and archived forum/public threads are counted');
  ok(byName.secret.noAccess === true && byName.secret.count === 0, '403 Missing Access is recorded, messages not counted');
  ok(byName.ideas && byName.ideas.error === 'forum-parent' && byName.ideas.count === 0, 'forum parents are not queried for messages');
  ok(!summary.channels.some((c) => c.name === 'Category'), 'categories are skipped');
  ok(summary.oldestLabel && summary.oldestLabel.includes('2017'), 'first message date comes from the oldest counted message');
  ok(summary.busiestMonth && summary.busiestMonth.month === '2023-11' && summary.busiestMonth.count >= 100, 'busiest month is computed');
  // 101 of text1 are in 2023-11 / 2023-ish from snowflake 1700000000000 = Nov 2023
  ok(summary.authors[0].name === 'Alice' || summary.authors[0].id === 'A', 'top author is present');
  ok(summary.notes.deletedChannels && /supprimés|irrécupérables/.test(summary.notes.deletedChannels), 'deleted channels are noted as unrecoverable');
  const dumped = fs.readFileSync(outFile, 'utf8');
  ok(!dumped.includes('hidden-') && !dumped.includes('SECRET') && !dumped.includes('first') && !dumped.includes(TOKEN), 'output JSON has no message content and no token');
  ok(calls.length && calls.every((c) => c.hasToken), 'requests used the token without tests logging it');
  ok(!dumped.includes('TESTTOKEN'), 'token is not written to the result file');

  // resume: state from a partial run, then finish
  const out2 = path.join(tmp, 'resume.json');
  const state2 = path.join(tmp, 'resume.state.json');
  fs.writeFileSync(state2, JSON.stringify({
    guildId: GUILD,
    results: [{ id: 'text1', name: 'blabla', type: 0, count: 101, noAccess: false }],
    totals: { total: 101, humans: 101, bots: 0, months: { '2023-11': 100, '2020-09': 1 }, authors: [{ id: 'A', name: 'alice', bot: false, count: 101 }] },
  }));
  const resumed = await fc.runAndSave({
    guildId: GUILD,
    outFile: out2,
    stateFile: state2,
    progressFile: path.join(tmp, 'resume.progress.json'),
    fresh: false,
    paceMs: 0,
    scanner: fc.createScanner({ token: TOKEN, fetch: mockFetch, sleep: async () => {}, now: () => 1_700_000_000_100, log: () => {}, paceMs: 0 }),
  });
  ok(resumed.total === 104 && resumed.notes.resume === true, 'resume skips already-counted channels and adds the rest');

  // 429 retry
  let saw429 = 0;
  let okAfter = 0;
  const retryFetch = async (url, init) => {
    if (String(url).includes('/messages') && saw429 === 0) {
      saw429 = 1;
      return {
        status: 429,
        headers: { get: (n) => (n === 'Retry-After' ? '0.01' : null) },
        json: async () => ({ retry_after: 0.01 }),
        text: async () => JSON.stringify({ retry_after: 0.01 }),
      };
    }
    okAfter += 1;
    return mockFetch(url, init);
  };
  await fc.runAndSave({
    guildId: GUILD,
    outFile: path.join(tmp, 'retry.json'),
    fresh: true,
    scanner: fc.createScanner({ token: TOKEN, fetch: retryFetch, sleep: async () => {}, now: () => Date.now(), log: () => {}, paceMs: 0 }),
  });
  ok(saw429 === 1 && okAfter > 0, '429 retry_after is honored and the request is retried');

  console.log(`${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
