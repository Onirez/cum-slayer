'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = fs.existsSync(path.join(__dirname, '..', 'auto_voice_policy.js'))
  ? path.join(__dirname, '..')
  : path.join(__dirname, '..', 'src');
const policy = require(path.join(root, 'auto_voice_policy.js'));

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${msg}`);
  } else {
    failed += 1;
    console.log(`FAIL ${msg}`);
  }
}

ok(policy.DEFAULT_RETURN_MS === 1000, 'default return delay is 1s');
ok(policy.parseReturnMs(undefined) === 1000, 'missing env keeps 1s');
ok(policy.parseReturnMs('1500') === 1500, 'accepts 1.5s');
ok(policy.parseReturnMs('2000') === 2000, 'accepts 2s');
ok(policy.parseReturnMs('50') === policy.MIN_RETURN_MS, 'clamps a too-short delay');
ok(policy.parseReturnMs('30000') === policy.MAX_RETURN_MS, 'clamps a too-long delay');
ok(policy.parseReturnMs('nope') === 1000, 'invalid env falls back to 1s');

const now = 1_000_000;
ok(policy.isRecentBotVoiceCommand({ channelId: 'busy', at: now - 100 }, 'busy', now), 'our own join is bot-initiated');
ok(policy.isRecentBotVoiceCommand({ channelId: 'busy', at: now - 100 }, null, now), 'brief null after destroy-then-join is bot-initiated');
ok(policy.isRecentBotVoiceCommand({ channelId: null, at: now - 100 }, null, now), 'our own leave is bot-initiated');
ok(!policy.isRecentBotVoiceCommand({ channelId: 'busy', at: now - 100 }, 'empty', now), 'a move to another channel is not our command');
ok(!policy.isRecentBotVoiceCommand({ channelId: 'busy', at: now - 20_000 }, 'busy', now), 'stale command window has expired');
ok(!policy.isRecentBotVoiceCommand(null, 'empty', now), 'no recent command');

function decide(partial) {
  return policy.decideForcedBotVoice(partial);
}

ok(decide({ initiatedByBot: true, destChannelId: 'empty', destHumans: 0, targetId: 'busy', targetHumans: 3 }).action === 'ignore', 'ignores bot-initiated moves');

const movedEmpty = decide({
  initiatedByBot: false, destChannelId: 'empty', destHumans: 0, targetId: 'busy', targetHumans: 3,
});
ok(movedEmpty.action === 'return' && movedEmpty.reason === 'forced-move' && movedEmpty.targetId === 'busy', 'forced move into an empty channel returns to the busiest');

const kicked = decide({
  initiatedByBot: false, destChannelId: null, destHumans: 0, targetId: 'busy', targetHumans: 2,
});
ok(kicked.action === 'return' && kicked.reason === 'forced-disconnect' && kicked.targetId === 'busy', 'kick while humans remain rejoins the busiest');

ok(decide({
  initiatedByBot: false, destChannelId: 'empty', destHumans: 0, targetId: null, targetHumans: 0,
}).action === 'defer', 'all-empty stays on the regular leave path');

ok(decide({
  initiatedByBot: false, destChannelId: 'other', destHumans: 2, targetId: 'busy', targetHumans: 3,
}).action === 'defer', 'a move into a channel that still has humans uses regular auto-voice');

ok(decide({
  initiatedByBot: false, destChannelId: 'busy', destHumans: 3, targetId: 'busy', targetHumans: 3,
}).action === 'defer', 'already in the busiest channel is a no-op');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
