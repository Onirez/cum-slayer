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
ok(vg.shouldGreet({ ...base, botChannelId: null }).reason === 'bot-not-in-voice', 'skips if bot is not in voice');
ok(vg.shouldGreet({ ...base, newChannelId: 'vc2' }).reason === 'other-channel', 'skips other channels');
ok(vg.shouldGreet({ ...base, oldChannelId: 'vc1' }).reason === 'no-channel-change', 'skips mute/deaf toggles');
ok(vg.shouldGreet({ ...base, channelType: 13 }).reason === 'not-voice', 'skips stage channels');
ok(vg.shouldGreet({ ...base, joinedAt: 999_000, graceMs: 8_000 }).reason === 'grace', 'skips during bot-join grace');
ok(vg.shouldGreet({ ...base, cooldownUntil: 2_000_000 }).reason === 'cooldown', 'honors per-user cooldown');
ok(vg.shouldGreet({ ...base, queueUserIds: new Set(['user1']) }).reason === 'already-queued', 'does not double-queue');
// bots ARE greeted
ok(vg.shouldGreet({ ...base, userId: 'otherbot' }).ok, 'greets other bots (no bot-user skip in shouldGreet)');

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

function member(id, name, bot = false) {
  return {
    guild: {
      id: 'g1',
      voiceStates: { cache: { get: (uid) => (uid === 'bot1' ? { channelId: 'vc1' } : null) } },
      channels: { cache: { get: (idc) => (idc === 'vc1' ? { id: 'vc1', type: 2 } : null) } },
      members: { cache: { get: () => null } },
    },
    id,
    channelId: 'vc1',
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
ok(graceRes.reason === 'grace', 'greeter applies grace after bot join');

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

g2._runQueue().then(() => {
  ok(plays.length === 2, `played both queued greetings (${plays.length})`);
  ok(plays.every((p) => p.exists), 'mp3 was on disk while playing');
  // leftover tmp files should be deleted
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}).catch((err) => {
  console.log('FAIL queue runner', err);
  process.exit(1);
});
