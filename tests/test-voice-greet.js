'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const root = fs.existsSync(path.join(__dirname, '..', 'voice_greet.js'))
  ? path.join(__dirname, '..')
  : path.join(__dirname, '..', 'src');
const vg = require(path.join(root, 'voice_greet.js'));

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

ok(vg.GREETINGS.length >= 20 && vg.GREETINGS.length <= 40, `~20-30 phrases (${vg.GREETINGS.length})`);
ok(vg.GREETINGS.every((p) => p.includes('{name}')), 'every phrase has {name}');
ok(vg.GREETINGS.every((p) => p.length <= 160), 'phrases stay short for TTS');

const banned = [
  'pédé', 'pede', 'tapette', 'gouine', 'pd ', 'nègre', 'negre',
  'triso', 'mongol', 'youpin', 'bougnoule', 'retardé', 'retard',
];
const blob = vg.GREETINGS.join(' ').toLowerCase();
ok(!banned.some((w) => blob.includes(w)), 'phrases have no slurs on protected traits');

ok(vg.cleanName('Onirez') === 'Onirez', 'keeps a simple name');
ok(vg.cleanName('  Jean-Pierre  ') === 'Jean-Pierre', 'trims and keeps hyphen');
ok(vg.cleanName('xX_Dark_Xx') === 'xX Dark Xx', 'underscores become spaces');
ok(vg.cleanName('🔥Baptiste🔥') === 'Baptiste', 'strips emoji');
ok(vg.cleanName('😎😎😎') === 'toi', 'emoji-only name becomes toi');
ok(vg.cleanName('') === 'toi', 'empty name becomes toi');
ok(vg.cleanName('Raphaël le fêtard !!!') === 'Raphaël le fêtard', 'keeps accents, drops bangs');
ok(vg.cleanName('a'.repeat(80)).length === 32, 'caps length at 32');

ok(vg.fillPhrase('Salut gros con de {name}.', 'Bluzzi') === 'Salut gros con de Bluzzi.', 'fills the name');

const picked = vg.pickPhrase('Max', -1);
ok(picked.text.includes('Max') && !picked.text.includes('{name}'), 'pickPhrase interpolates');

const base = {
  botId: 'bot1',
  botChannelId: 'vc1',
  userId: 'user1',
  oldChannelId: null,
  newChannelId: 'vc1',
  channelType: 2,
  now: 1_000_000,
  joinedAt: 0,
  graceMs: 8_000,
  cooldownUntil: 0,
};
ok(vg.shouldGreet(base).ok, 'greets a user who just joined the bot channel');
ok(vg.shouldGreet({ ...base, userId: 'bot1' }).reason === 'self', 'does not greet itself');
ok(vg.shouldGreet({ ...base, botChannelId: null }).ok, 'greets even if the bot is not yet in voice');
ok(vg.shouldGreet({ ...base, oldChannelId: 'vc1', newChannelId: 'vc2' }).ok, 'greets a move to a different channel than the bot');
ok(vg.shouldGreet({ ...base, oldChannelId: 'vc-other' }).ok, 'greets a move from another voice channel');
ok(vg.shouldGreet({ ...base, oldChannelId: 'vc1' }).reason === 'no-channel-change', 'skips mute/deaf toggles');
ok(vg.shouldGreet({ ...base, channelType: 13 }).reason === 'not-voice', 'skips stage channels');
ok(vg.shouldGreet({ ...base, joinedAt: 999_000, graceMs: 8_000 }).ok, 'an arrival is not blocked by bot-join grace');
ok(vg.shouldGreet({ ...base, cooldownUntil: 2_000_000 }).reason === 'cooldown', 'honors per-user-per-channel cooldown');
ok(vg.shouldGreet({ ...base, queueUserIds: new Set(['user1']) }).reason === 'already-queued', 'does not double-queue');
// bots ARE greeted
ok(vg.shouldGreet({ ...base, userId: 'otherbot' }).ok, 'greets other bots (no bot-user skip in shouldGreet)');
ok(vg.cooldownKey('u1', 'vc2') === 'u1:vc2', 'cooldown key is per user per channel');

ok(typeof vg.findFfmpeg === 'function', 'findFfmpeg is exported');
ok(vg.hasFfmpeg() === Boolean(vg.findFfmpeg()), 'hasFfmpeg is existsSync, not a short spawn');


// greeter wiring with fake TTS/play
const plays = [];
const greeter = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => 5_000_000,
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => { fs.writeFileSync(dest, Buffer.from('ID3fake')); return dest; },
  play: async (guildId, file) => { plays.push({ guildId, file, exists: fs.existsSync(file) }); },
});

function member(id, name, bot = false, channelId = 'vc1', botChannelId = 'vc1') {
  return {
    guild: {
      id: 'g1',
      voiceStates: { cache: { get: (uid) => (uid === 'bot1' && botChannelId ? { channelId: botChannelId } : null) } },
      channels: { cache: { get: (idc) => (idc === 'vc1' || idc === 'vc2' ? { id: idc, type: 2 } : null) } },
      members: { cache: { get: () => null } },
    },
    id,
    channelId,
    member: { displayName: name, user: { bot, username: name } },
  };
}

greeter.markJoined('g1', 'vc1');
// grace: just joined
const tooSoon = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => 5_000_000,
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => dest,
  play: async () => {},
});
tooSoon.markJoined('g1', 'vc1');
const graceRes = tooSoon.handleVoiceStateUpdate({ channelId: null }, member('u2', 'Bluzzi'));
ok(graceRes.ok && graceRes.name === 'Bluzzi', 'a real arrival is greeted even if the bot just joined');

// after grace window
const later = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: (() => { let t = 20_000_000; return () => t; })(),
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => { fs.writeFileSync(dest, Buffer.from('ID3xxxx')); return dest; },
  play: async (guildId, file) => { plays.push({ guildId, file, exists: fs.existsSync(file) }); },
});
later.markJoined('g1', 'vc1');
// rewind joinedAt into the past
later.markJoined('g1', 'vc1');
// hack: markJoined uses now() which is 20_000_000, grace 8s — still in grace!
// use a greeter whose join was earlier
const seq = { t: 1_000 };
const g2 = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => seq.t,
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => { fs.writeFileSync(dest, Buffer.from('ID3xxxx')); return dest; },
  play: async (guildId, file) => { plays.push({ name: 'play', guildId, exists: fs.existsSync(file) }); },
});
seq.t = 1_000;
g2.markJoined('g1', 'vc1');
seq.t = 20_000; // 19s later, grace over
const r1 = g2.handleVoiceStateUpdate({ channelId: null }, member('u3', 'Onirez'));
ok(r1.ok && r1.name === 'Onirez' && r1.text.includes('Onirez'), 'queues a human after grace');
const r1b = g2.handleVoiceStateUpdate({ channelId: null }, member('u3', 'Onirez'));
ok(r1b.reason === 'cooldown' || r1b.reason === 'already-queued', 'same user is on cooldown or still queued');
const rBot = g2.handleVoiceStateUpdate({ channelId: null }, member('u4', 'Max Verstappen', true));
ok(rBot.ok && rBot.name === 'Max Verstappen', 'queues a bot joiner too');
const rSelf = g2.handleVoiceStateUpdate({ channelId: null }, member('bot1', 'cûm slayer', true));
ok(rSelf.reason === 'self', 'still refuses to greet itself');

// markJoined on the same channel must not restart grace (the Léo bug)
const graceClock = { t: 1_000 };
const noReset = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => graceClock.t,
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => dest,
  play: async () => {},
});
graceClock.t = 1_000;
noReset.markJoined('g1', 'vc1');
graceClock.t = 10_000; // grace would be over unless a later markJoined reset it
noReset.markJoined('g1', 'vc1');
graceClock.t = 11_000;
const afterReassert = noReset.handleVoiceStateUpdate({ channelId: null }, member('u-grace', 'Leo'));
ok(afterReassert.ok, 're-asserting the same channel does not restart grace');

// skip reasons are logged for events in the bot channel
const skips = [];
const logClock = { t: 1_000 };
const logger = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => logClock.t,
  getBotId: () => 'bot1',
  log: (m) => skips.push(m),
  fetchTts: async (text, dest) => dest,
  play: async () => {},
});
logClock.t = 1_000;
logger.markJoined('g1', 'vc1');
logClock.t = 20_000;
const muteSkip = logger.handleVoiceStateUpdate(
  { ...member('u-mute', 'Muted'), channelId: 'vc1' },
  member('u-mute', 'Muted'),
);
ok(muteSkip.reason === 'no-channel-change', 'mute is not an arrival');
ok(skips.some((m) => /skip user=u-mute/.test(m) && /reason=no-channel-change/.test(m)), 'logs skip reason for mute in bot channel');

const moveRes = logger.handleVoiceStateUpdate(
  { ...member('u-move', 'Leo'), channelId: 'vc-other' },
  member('u-move', 'Leo'),
);
ok(moveRes.ok && moveRes.name === 'Leo', 'handle greets a move from another channel');
ok(skips.some((m) => /queued user=u-move/.test(m) && /from_move=yes/.test(m)), 'logs move arrivals as queued from_move');

const hopLogs = [];
const hopper = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => 20_000,
  getBotId: () => 'bot1',
  log: (m) => hopLogs.push(m),
  fetchTts: async (text, dest) => dest,
  play: async () => {},
});
hopper.markJoined('g1', 'vc1');
const hopRes = hopper.handleVoiceStateUpdate(
  { ...member('u-hop', 'Leo'), channelId: 'vc1' },
  member('u-hop', 'Leo', false, 'vc2'),
);
ok(hopRes.ok && hopRes.name === 'Leo', 'greets a move out of the bot channel into another');
ok(hopper._queue.some((j) => j.userId === 'u-hop' && j.channelId === 'vc2'), 'queued job targets the destination channel');
ok(hopLogs.some((m) => /queued user=u-hop/.test(m) && /from_move=yes/.test(m) && /follow=yes/.test(m)), 'logs a follow move to the destination');
ok(hopper.heldChannel('g1') === 'vc2', 'holds auto-voice on the destination while the greet is queued');

const noBotLogs = [];
const lonely = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => 20_000,
  getBotId: () => 'bot1',
  log: (m) => noBotLogs.push(m),
  fetchTts: async (text, dest) => dest,
  play: async () => {},
});
const joinEmpty = lonely.handleVoiceStateUpdate(
  { ...member('u-empty', 'Sam', false, null, null), channelId: null },
  member('u-empty', 'Sam', false, 'vc2', null),
);
ok(joinEmpty.ok && joinEmpty.name === 'Sam', 'greets a join even if the bot is not in any voice channel');
ok(lonely._queue.some((j) => j.userId === 'u-empty' && j.channelId === 'vc2'), 'empty-join job targets the destination');
ok(noBotLogs.some((m) => /queued user=u-empty/.test(m) && /botchan=none/.test(m)), 'logs a join when the bot is not in voice');

const retarget = hopper.handleVoiceStateUpdate(
  { ...member('u-hop', 'Leo', false, 'vc2'), channelId: 'vc2' },
  member('u-hop', 'Leo', false, 'vc1'),
);
ok(retarget.ok && retarget.retargeted, 'retargets a still-queued greet when the same user moves again');
ok(hopper._queue.filter((j) => j.userId === 'u-hop').length === 1, 'does not enqueue a second job for the same user');
ok(hopper._queue.some((j) => j.userId === 'u-hop' && j.channelId === 'vc1'), 'retargeted job follows the latest destination');
ok(hopLogs.some((m) => /retarget user=u-hop/.test(m) && /new=vc1/.test(m)), 'logs the retarget');

// failed play must not arm the cooldown
const failClock = { t: 20_000 };
const failPlays = [];
const flaky = vg.createVoiceGreeter({
  enabled: true,
  cooldownMs: 10 * 60 * 1000,
  graceMs: 8_000,
  now: () => failClock.t,
  getBotId: () => 'bot1',
  log: () => {},
  fetchTts: async (text, dest) => { fs.writeFileSync(dest, Buffer.from('ID3xxxx')); return dest; },
  play: async () => {
    failPlays.push(failClock.t);
    if (failPlays.length === 1) throw new Error('boom');
  },
});
failClock.t = 1_000;
flaky.markJoined('g1', 'vc1');
failClock.t = 20_000;
const firstTry = flaky.handleVoiceStateUpdate({ channelId: null }, member('u-fail', 'Baptiste'));
ok(firstTry.ok, 'queues first attempt');

g2._runQueue().then(async () => {
  ok(plays.length === 2, `played both queued greetings (${plays.length})`);
  ok(plays.every((p) => p.exists), 'mp3 was on disk while playing');
  await flaky._runQueue();
  failClock.t = 21_000;
  const retry = flaky.handleVoiceStateUpdate({ channelId: 'vc-other' }, member('u-fail', 'Baptiste'));
  ok(retry.ok, 'no cooldown after a greet that was not played');
  await flaky._runQueue();
  ok(failPlays.length === 2, 'retried play after previous failure');

  const cdClock = { t: 20_000 };
  const cdPlays = [];
  const idle = [];
  const cdg = vg.createVoiceGreeter({
    enabled: true,
    cooldownMs: 10 * 60 * 1000,
    graceMs: 8_000,
    now: () => cdClock.t,
    getBotId: () => 'bot1',
    log: () => {},
    fetchTts: async (text, dest) => { fs.writeFileSync(dest, Buffer.from('ID3xxxx')); return dest; },
    play: async () => { cdPlays.push(cdClock.t); },
    onQueueIdle: () => idle.push(cdClock.t),
  });
  cdClock.t = 1_000;
  cdg.markJoined('g1', 'vc1');
  cdClock.t = 20_000;
  ok(cdg.handleVoiceStateUpdate({ channelId: null }, member('u-cd', 'Sam')).ok, 'queues first join in vc1');
  await cdg._runQueue();
  ok(cdPlays.length === 1, 'played the first vc1 greet');
  ok(idle.length === 1, 'notifies auto-voice when the greet queue is idle');
  const sameChan = cdg.handleVoiceStateUpdate({ channelId: null }, member('u-cd', 'Sam'));
  ok(sameChan.reason === 'cooldown', 'same user in the same channel stays on the 10 min cooldown');
  const otherChan = cdg.handleVoiceStateUpdate(
    { ...member('u-cd', 'Sam'), channelId: 'vc1' },
    member('u-cd', 'Sam', false, 'vc2'),
  );
  ok(otherChan.ok, 'same user moving to a new channel is greeted despite the other channel cooldown');
  await cdg._runQueue();
  ok(cdPlays.length === 2, 'played the greet in the new channel');
  const back = cdg.handleVoiceStateUpdate(
    { ...member('u-cd', 'Sam', false, 'vc2'), channelId: 'vc2' },
    member('u-cd', 'Sam', false, 'vc1'),
  );
  ok(back.reason === 'cooldown', 'returning to a channel already greeted stays on cooldown');
  ok(cdg.heldChannel('g1') == null, 'hold is released after the queue drains');

  // leftover tmp files should be deleted
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}).catch((err) => {
  console.log('FAIL queue runner', err);
  process.exit(1);
});
