'use strict';
// Offline tests for the /restart slash command. No Discord, no Fly, no process.exit.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const restart = fs.existsSync(path.join(root, 'restart.js'))
  ? require('../restart')
  : require('../src/restart');
const {
  commandPayload, isCreator, decideRestart, registerRestartCommand, performRestart,
  COMMAND_NAME, COOLDOWN_MS, REFUSAL, COOLDOWN_REPLY, OK_REPLY,
} = restart;

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const CREATOR = '965544860528562216';
const OTHER = '111111111111111111';

ok(isCreator(CREATOR, CREATOR), 'creator id matches');
ok(isCreator(String(CREATOR), CREATOR), 'creator id matches as string');
ok(!isCreator(OTHER, CREATOR), 'a different id is not the creator');
ok(!isCreator('Onirez', CREATOR), 'the username Onirez is not trusted');
ok(!isCreator(CREATOR.toLowerCase && 'onirez', CREATOR), 'a username lookalike is not the creator');
ok(!isCreator(undefined, CREATOR), 'missing user id is not the creator');
ok(!isCreator(CREATOR, undefined), 'missing creator id is not the creator');
ok(!isCreator('', CREATOR), 'empty user id is not the creator');

const denied = decideRestart({ userId: OTHER, creatorId: CREATOR });
ok(denied.ok === false && denied.reason === 'forbidden', 'non-creator is refused');
ok(denied.ephemeral === true && denied.reply === REFUSAL, 'non-creator gets an ephemeral arrogant refusal');
ok(/pas à toi|Circule|Non/.test(denied.reply), 'refusal is a French no');

const byName = decideRestart({ userId: 'Onirez', creatorId: CREATOR });
ok(byName.ok === false && byName.reason === 'forbidden', 'username Onirez with the wrong id is refused');

const spoof = decideRestart({ userId: 'Onirez', creatorId: 'Onirez' });
ok(spoof.ok === true, 'id comparison is used even if both happen to be the same string — still only ids, no display names involved');

const allowed = decideRestart({ userId: CREATOR, creatorId: CREATOR, lastAt: 0 });
ok(allowed.ok === true && allowed.reason === 'ok' && allowed.reply === OK_REPLY, 'creator is allowed');
ok(allowed.ephemeral === true, 'creator acknowledgement is also ephemeral');

const now = 1_000_000;
const cooling = decideRestart({ userId: CREATOR, creatorId: CREATOR, now, lastAt: now - 1_000 });
ok(cooling.ok === false && cooling.reason === 'cooldown' && cooling.reply === COOLDOWN_REPLY, 'creator hits the 30 s cooldown');

const after = decideRestart({ userId: CREATOR, creatorId: CREATOR, now, lastAt: now - COOLDOWN_MS });
ok(after.ok === true, 'creator may restart again at the 30 s mark');

const still = decideRestart({ userId: OTHER, creatorId: CREATOR, now, lastAt: now - 1_000 });
ok(still.reason === 'forbidden', 'non-creator is refused even during the cooldown window (never restarts)');

const cmd = commandPayload();
ok(cmd.name === COMMAND_NAME && cmd.name === 'restart', 'command name is /restart');
ok(cmd.type === 1, 'command is CHAT_INPUT');
ok(cmd.default_member_permissions === '8', 'default_member_permissions is Administrator (8) so non-admins do not see it');
ok(cmd.dm_permission === false, 'command is not registered in DMs');
ok(typeof cmd.description === 'string' && /créateur|createur/i.test(cmd.description), 'description says it is creator-only');

// register: edit when present, create when missing, never set() (would wipe others)
const calls = [];
const existingOther = { id: 'cmd-other', name: 'other' };
const existingRestart = { id: 'cmd-restart', name: 'restart' };
const commands = {
  async fetch({ guildId }) {
    calls.push(['fetch', guildId]);
    if (guildId === 'g-has') return new Map([['1', existingOther], ['2', existingRestart]]);
    if (guildId === 'g-empty') return new Map([['1', existingOther]]);
    return new Map();
  },
  async edit(id, data, guildId) { calls.push(['edit', id, data.name, guildId]); return { id }; },
  async create(data, guildId) { calls.push(['create', data.name, guildId]); return { id: 'new-' + guildId }; },
  async set(data, guildId) { calls.push(['set', guildId]); return data; },
};
(async () => {
  const results = await registerRestartCommand({
    applicationCommands: commands,
    guildIds: ['g-has', 'g-empty', 'g-new'],
  });
  ok(results.length === 3, 'registers on every allowed guild');
  ok(results[0].action === 'updated' && results[0].id === 'cmd-restart', 'edits /restart when it already exists');
  ok(results[1].action === 'created' && results[2].action === 'created', 'creates /restart when missing');
  ok(!calls.some((c) => c[0] === 'set'), 'does not call commands.set (would wipe other guild commands)');
  ok(calls.some((c) => c[0] === 'edit' && c[1] === 'cmd-restart' && c[3] === 'g-has'), 'edit targets the existing /restart id');

  let destroyed = 0;
  let exitCode = null;
  const logs = [];
  await performRestart({
    userId: CREATOR,
    destroy: async () => { destroyed += 1; },
    exit: (code) => { exitCode = code; },
    log: (m) => logs.push(m),
  });
  ok(destroyed === 1, 'performRestart destroys the client');
  ok(exitCode === 1, 'performRestart exits with code 1 so Fly on-failure / always restarts the machine');
  ok(logs.some((m) => /restart/.test(m) && /creator/.test(m)), 'performRestart logs the creator restart');

  let exitedOnDestroyFail = null;
  await performRestart({
    userId: CREATOR,
    destroy: async () => { throw new Error('already closing'); },
    exit: (code) => { exitedOnDestroyFail = code; },
    log: () => {},
  });
  ok(exitedOnDestroyFail === 1, 'still exits 1 if client.destroy() throws');

  // Non-creator path must never call performRestart in the bridge; this just
  // documents that decideRestart is the gate.
  ok(decideRestart({ userId: OTHER, creatorId: CREATOR }).ok === false, 'gate keeps performRestart off the non-creator path');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
