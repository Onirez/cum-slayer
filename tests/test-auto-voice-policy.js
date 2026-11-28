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


ok(policy.DEFAULT_LEAVE_RETURN_MS === 400, 'default leave-return delay is 400ms');
ok(policy.parseReturnMs(undefined, policy.DEFAULT_LEAVE_RETURN_MS) === 400, 'leave-return fallback is 400ms when env is unset');
ok(policy.parseReturnMs('300', policy.DEFAULT_LEAVE_RETURN_MS) === 300, 'leave-return accepts 300ms');
ok(policy.parseReturnMs('50', policy.DEFAULT_LEAVE_RETURN_MS) === policy.MIN_RETURN_MS, 'leave-return still clamps a too-short delay');

function after(partial) {
  return policy.decideAfterUserLeave(partial);
}

ok(after({
  botChannelId: 'busy', currentHumans: 2, targetId: 'busy', targetHumans: 2, greetHoldChannelId: null, trigger: 'leave',
}).action === 'ignore' && after({
  botChannelId: 'busy', currentHumans: 2, targetId: 'busy', targetHumans: 2, trigger: 'leave',
}).reason === 'already-busiest', 'stays when the current channel is already the busiest');

ok(after({
  botChannelId: 'side', currentHumans: 1, targetId: 'side', targetHumans: 1, greetHoldChannelId: null, trigger: 'leave',
}).action === 'ignore', 'stays when the current channel is tied for the busiest');

const alone = after({
  botChannelId: 'side', currentHumans: 0, targetId: 'busy', targetHumans: 2, greetHoldChannelId: null, trigger: 'leave',
});
ok(alone.action === 'return' && alone.reason === 'after-leave' && alone.targetId === 'busy', 'returns to the busiest channel when the bot is left alone');

const fewer = after({
  botChannelId: 'side', currentHumans: 1, targetId: 'busy', targetHumans: 3, greetHoldChannelId: null, trigger: 'leave',
});
ok(fewer.action === 'return' && fewer.reason === 'after-leave' && fewer.targetId === 'busy', 'returns when the current channel has fewer humans than the busiest');

ok(after({
  botChannelId: 'side', currentHumans: 0, targetId: 'busy', targetHumans: 2, greetHoldChannelId: 'side', trigger: 'leave',
}).action === 'hold' && after({
  botChannelId: 'side', currentHumans: 0, targetId: 'busy', targetHumans: 2, greetHoldChannelId: 'side',
}).reason === 'greet-pending', 'holds the return while a greet is still playing or queued in this channel');

ok(after({
  botChannelId: 'side', currentHumans: 0, targetId: 'busy', targetHumans: 2, greetHoldChannelId: 'other', trigger: 'leave',
}).action === 'hold', 'holds the return while a greet is pending in another channel');

ok(after({
  botChannelId: 'side', currentHumans: 0, targetId: null, targetHumans: 0, greetHoldChannelId: null, trigger: 'leave',
}).action === 'defer' && after({
  botChannelId: 'side', currentHumans: 0, targetId: null, targetHumans: 0, trigger: 'leave',
}).reason === 'all-empty', 'all-empty stays on the regular leave path');

const idleAlone = after({
  botChannelId: 'side', currentHumans: 0, targetId: 'busy', targetHumans: 2, greetHoldChannelId: null, trigger: 'idle',
});
ok(idleAlone.action === 'return' && idleAlone.reason === 'greet-idle' && idleAlone.targetId === 'busy', 'after the queue drains, returns if they left before or during the greeting');

ok(after({
  botChannelId: 'side', currentHumans: 1, targetId: 'busy', targetHumans: 3, greetHoldChannelId: null, trigger: 'idle',
}).action === 'defer' && after({
  botChannelId: 'side', currentHumans: 1, targetId: 'busy', targetHumans: 3, trigger: 'idle',
}).reason === 'still-occupied', 'after a greet, does not immediately leave people still in the channel');

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
