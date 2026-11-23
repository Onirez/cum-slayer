'use strict';
// Offline tests for the consecutive bot-to-bot loop guard. No Discord, no Fly.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const scopePath = fs.existsSync(path.join(root, 'scope.js')) ? path.join(root, 'scope.js') : path.join(root, 'src', 'scope.js');
const bridgePath = fs.existsSync(path.join(root, 'bridge.js')) ? path.join(root, 'bridge.js') : path.join(root, 'src', 'bridge.js');
const scope = require(scopePath);

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const CH = '111111111111111111';
const CH2 = '222222222222222222';
const BOT_A = '333333333333333333';
const BOT_B = '444444444444444444';
const t0 = 1_700_000_000_000;
const IDLE = 20_000;

const g = new scope.BotLoopGuard({ maxPerWindow: 5, idleMs: IDLE, authorCooldownMs: 5_000 });
ok(g.max === 5 && g.idleMs === IDLE, 'defaults used: max 5, idle 20 s');

let allowed = 0;
let t = t0;
for (let i = 0; i < 8; i++) {
  const c = g.check(CH, BOT_A, t);
  if (c.ok) { g.record(CH, BOT_A, t); allowed++; }
  t += 6_000;
}
ok(allowed === 5, `consecutive cap allows exactly 5 replies (${allowed})`);
const lastReply = t0 + 6_000 * 4; // 5th record (i=0..4)
ok(g.isCapped(CH, lastReply + 1), 'isCapped is true after 5 replies');
ok(!g.check(CH, BOT_A, lastReply + 1).ok && !g.check(CH, BOT_B, lastReply + 1).ok, '6th reply refused for every bot in the channel, including another bot');

// Ignored messages while capped must not extend the idle timer
ok(!g.check(CH, BOT_A, lastReply + IDLE - 1).ok, 'still capped just before the idle timeout');
ok(!g.isCapped(CH, lastReply + IDLE) && g.check(CH, BOT_A, lastReply + IDLE).ok, 'streak resets after 20 s idle, even if bots kept talking (we did not record those)');

// human reset
const g2 = new scope.BotLoopGuard({ maxPerWindow: 5, idleMs: IDLE, authorCooldownMs: 0 });
for (let i = 0; i < 5; i++) g2.record(CH, BOT_A, t0 + i);
ok(g2.isCapped(CH, t0 + 5), 'precondition: capped');
g2.noteHuman(CH);
ok(!g2.isCapped(CH, t0 + 5) && g2.check(CH, BOT_A, t0 + 5).ok, 'a human message resets the streak immediately');
g2.record(CH, BOT_A, t0 + 5);
ok(g2._state(CH, t0 + 5).count === 1, 'streak restarts at 1 after a human');

// channels are independent
const g3 = new scope.BotLoopGuard({ maxPerWindow: 2, idleMs: IDLE, authorCooldownMs: 0 });
g3.record(CH, BOT_A, t0);
g3.record(CH, BOT_A, t0 + 1);
ok(g3.isCapped(CH, t0 + 2) && !g3.isCapped(CH2, t0 + 2) && g3.check(CH2, BOT_A, t0 + 2).ok, 'cap is per channel');

// author cooldown does not increment the streak
const g4 = new scope.BotLoopGuard({ maxPerWindow: 5, idleMs: IDLE, authorCooldownMs: 5_000 });
ok(g4.check(CH, BOT_A, t0).ok, 'first check allowed');
g4.record(CH, BOT_A, t0);
ok(!g4.check(CH, BOT_A, t0 + 4_000).ok, 'same bot within 5 s is on cooldown');
ok(g4._state(CH, t0 + 4_000).count === 1, 'cooldown refusal does not increment the consecutive count');
ok(g4.check(CH, BOT_A, t0 + 5_000).ok, 'same bot allowed after the 5 s cooldown');
ok(g4.check(CH, BOT_B, t0 + 1_000).ok, 'a different bot is not blocked by the author cooldown');

// windowMs alias still works
const g5 = new scope.BotLoopGuard({ maxPerWindow: 1, windowMs: 60_000, authorCooldownMs: 0 });
g5.record(CH, BOT_A, t0);
ok(g5.isCapped(CH, t0 + 59_999) && !g5.isCapped(CH, t0 + 60_000), 'windowMs is accepted as an alias for idleMs');

// constructor defaults
const g6 = new scope.BotLoopGuard();
ok(g6.max === 5 && g6.idleMs === 20_000 && g6.cooldown === 5_000, 'constructor defaults are 5 / 20 s / 5 s');

// bridge wiring: cap is checked in the bridge, silently, before the webhook
const src = fs.readFileSync(bridgePath, 'utf8');
ok(/botLoopGuard\.isCapped\(message\.channelId\)/.test(src), 'bridge silently skips bot authors once the channel is capped');
ok(/skip bot-loop trigger=capped/.test(src), 'capped skips are logged as skip bot-loop, no webhook');
ok(/noteHuman\(message\.channelId\)/.test(src) && /!authorIsBot/.test(src), 'human messages reset the guard; bot authors do not');
ok(/BOT_LOOP_MAX/.test(src) && (/BOT_LOOP_IDLE_MS/.test(src) || /config\.BOT_LOOP_IDLE_MS/.test(src)), 'limit and idle timeout are configurable');
// confirm we don't add a reaction on skip
const skipBlock = src.slice(src.indexOf('botLoopGuard.isCapped'), src.indexOf('botLoopGuard.isCapped') + 800);
ok(!/react\(/.test(skipBlock), 'capped skip does not add a reaction');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
