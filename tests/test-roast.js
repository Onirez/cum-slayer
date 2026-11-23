'use strict';
if (!process.env.DISCORD_BOT_TOKEN) {
  console.log('SKIP test-roast.js: DISCORD_BOT_TOKEN is not set (live test)');
  process.exit(0);
}
// Daily roast tests (REST reads only; temp state files; no webhook, no post).
const fs = require('fs');
const path = require('path');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roast-'));
process.env.ROAST_CONTACTS_FILE = path.join(tmp, 'contacts.json');
process.env.ROAST_STATE_FILE = path.join(tmp, 'roast.json');
const roast = require('../src/roast');
const { spawnSync } = require('child_process');
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };
const LEO = '161097653214511104'; const COCO = '287660180412301323'; const CREATOR = '965544860528562216'; const ARCH = '1573860551610863766';
(async () => {
  const now = Date.now();
  fs.writeFileSync(process.env.ROAST_CONTACTS_FILE, JSON.stringify({ users: {
    [LEO]: { last_channel_id: '1455708291731820627', last_at: now, count: 3 },
    [COCO]: { last_channel_id: '1574094942085586995', last_at: now, count: 2 },
    [CREATOR]: { last_channel_id: '1571542249051783228', last_at: now, count: 9 },
    [ARCH]: { last_channel_id: '1571542249051783228', last_at: now, count: 9 },
  } }));
  fs.writeFileSync(process.env.ROAST_STATE_FILE, JSON.stringify({ history: [{ user_id: LEO, at: now - 86400000 }] }));
  for (let i = 0; i < 4; i++) {
    const p = await roast.pickTarget({ rand: Math.random });
    ok(p && p.member.user.id === COCO, `run ${i}: picks the person not roasted in 5 days (got ${p && p.member.user.username})`);
  }
  ok((await roast.pickTarget({ forcedId: CREATOR })) === null, 'creator is never a target');
  ok((await roast.pickTarget({ forcedId: ARCH })) === null, 'bots are never targets');
  fs.writeFileSync(process.env.ROAST_STATE_FILE, JSON.stringify({ history: [{ user_id: LEO, at: now }, { user_id: COCO, at: now }] }));
  const p2 = await roast.pickTarget();
  ok(p2 && [LEO, COCO].includes(p2.member.user.id) && p2.recently_roasted, 'falls back to a recently roasted person when everyone was roasted');
  const pl = await roast.buildRoastPayload({ forcedId: COCO });
  ok(pl.trigger === 'daily_roast' && pl.message_id === null && pl.in_agents === true, 'payload: daily_roast, message_id null, in_agents true');
  ok(pl.channel_id === '1574094942085586995', 'payload channel = AGENTS channel where they last talked with the bot');
  ok(pl.target.id === COCO && Array.isArray(pl.target_messages) && pl.target_messages.length <= 15, `payload has target + ${pl.target_messages.length} AGENTS messages`);
  ok(!JSON.stringify(pl).includes(process.env.DISCORD_BOT_TOKEN), 'payload contains no token');
  fs.writeFileSync(process.env.ROAST_CONTACTS_FILE, JSON.stringify({ users: { [COCO]: { last_channel_id: '1455535721850077244', last_at: now, count: 1 } } }));
  ok((await roast.buildRoastPayload({ forcedId: COCO })).channel_id === roast.FALLBACK_CHANNEL_ID, 'non-AGENTS last channel falls back to agent-1');
  // act.sh standalone posting guard
  const run = (json) => spawnSync(path.join(__dirname, '..', 'scripts', 'act.sh'), ['--dry-run'], { input: JSON.stringify(json), encoding: 'utf8', env: process.env });
  const a = run({ channel_id: '1571542249051783228', message_id: null, reply: `roast <@${COCO}>`, react: null });
  ok(a.status === 0 && a.stdout.includes(`"users":["${COCO}"]`), 'act.sh standalone post in agent-1 OK with target ping only');
  const b = run({ channel_id: '1455535721850077244', message_id: null, reply: 'x', react: null });
  ok(b.status !== 0 && /refused/.test(b.stderr), 'act.sh standalone post outside AGENTS refused');
  const c = run({ channel_id: '1571542249051783228', message_id: null, reply: null, react: '🔥' });
  ok(c.status !== 0, 'react without message_id refused');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
