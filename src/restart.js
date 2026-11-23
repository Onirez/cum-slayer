'use strict';

/**
 * /restart slash command: creator-only, ephemeral replies, then a clean
 * process exit(1) so Fly (restart policy on-failure / always) brings the
 * machine back. Decisions are pure and unit-testable; no Discord I/O here.
 */

const COMMAND_NAME = 'restart';
const COOLDOWN_MS = 30_000;
const ADMINISTRATOR = 8n;

const REFUSAL = 'Non. Cette commande n\'est pas à toi. Circule.';
const COOLDOWN_REPLY = 'Doucement, j\'ai déjà un redémarrage en cours.';
const OK_REPLY = 'Redémarrage…';

function commandPayload() {
  return {
    name: COMMAND_NAME,
    description: 'Redémarre le bot (créateur uniquement).',
    type: 1, // CHAT_INPUT
    default_member_permissions: String(ADMINISTRATOR),
    dm_permission: false,
  };
}

function isCreator(userId, creatorId) {
  return Boolean(userId && creatorId && String(userId) === String(creatorId));
}

/**
 * Decide whether /restart may proceed.
 * Only interaction.user.id is trusted — never a username.
 * lastAt is the in-process timestamp of the last accepted restart (0 if none).
 */
function decideRestart({ userId, creatorId, now = Date.now(), lastAt = 0 } = {}) {
  if (!isCreator(userId, creatorId)) {
    return { ok: false, reason: 'forbidden', reply: REFUSAL, ephemeral: true };
  }
  if (lastAt && now - lastAt < COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown', reply: COOLDOWN_REPLY, ephemeral: true };
  }
  return { ok: true, reason: 'ok', reply: OK_REPLY, ephemeral: true };
}

/**
 * Upsert /restart as a guild command on each allowed guild (immediate).
 * Does not wipe other guild commands (create or edit only).
 * applicationCommands = client.application.commands
 */
async function registerRestartCommand({ applicationCommands, guildIds, log } = {}) {
  if (!applicationCommands || typeof applicationCommands.fetch !== 'function') {
    throw new Error('applicationCommands is required');
  }
  const data = commandPayload();
  const ids = [...new Set((guildIds || []).map(String).filter(Boolean))];
  const results = [];
  for (const guildId of ids) {
    const existing = await applicationCommands.fetch({ guildId });
    const list = existing && typeof existing.values === 'function' ? [...existing.values()] : [];
    const found = list.find((c) => c && c.name === COMMAND_NAME);
    if (found) {
      await applicationCommands.edit(found.id, data, guildId);
      if (log) log(`slash /restart registered guild=${guildId} (updated)`);
      results.push({ guildId, action: 'updated', id: found.id });
    } else {
      const created = await applicationCommands.create(data, guildId);
      if (log) log(`slash /restart registered guild=${guildId}`);
      results.push({ guildId, action: 'created', id: created && created.id });
    }
  }
  return results;
}

/**
 * After an accepted /restart: log, destroy the Discord client, exit 1.
 * destroy / exit are injected so tests never kill the process.
 */
async function performRestart({ destroy, exit, log, userId } = {}) {
  if (log) log(`slash /restart by creator user=${userId}, destroying client and exiting for Fly restart`);
  try {
    if (typeof destroy === 'function') await destroy();
  } catch (err) {
    if (log) log(`restart destroy: ${err && err.message ? err.message : err}`);
  }
  if (typeof exit === 'function') exit(1);
  else process.exit(1);
}

module.exports = {
  COMMAND_NAME,
  COOLDOWN_MS,
  ADMINISTRATOR,
  REFUSAL,
  COOLDOWN_REPLY,
  OK_REPLY,
  commandPayload,
  isCreator,
  decideRestart,
  registerRestartCommand,
  performRestart,
};
