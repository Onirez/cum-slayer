'use strict';

/**
 * Guild slash commands other than /restart: /classement (local leaderboard)
 * and /fiche (AI portrait via the routine webhook).
 *
 * Interaction tokens are stored on disk so act.sh can follow up a deferred
 * /fiche. The token is never logged, never put in a webhook payload, and
 * never returned to the routine.
 */

const fs = require('fs');
const path = require('path');
const { sanitizeMassMentions, allowedMentions } = require('./lib');

let DATA_DIR;
try { DATA_DIR = require('./config').DATA_DIR; } catch { DATA_DIR = path.join(__dirname, 'data'); }

const CLASSEMENT = 'classement';
const FICHE = 'fiche';
const CLASSEMENT_COOLDOWN_MS = 30_000;
const FICHE_COOLDOWN_MS = 60_000;
const FICHE_HOURLY_MAX = 20;
const FICHE_HOURLY_MS = 60 * 60 * 1000;
const INTERACTION_TTL_MS = 14 * 60 * 1000; // Discord tokens last 15 min; drop a bit early
const FICHE_HINT = 'Portrait rôti et court, uniquement à partir des notes et messages publics de la cible. Interdit : vrai nom, adresse, école, boulot, santé, ou toute donnée sensible. Ne récite pas les logs, transforme-les en fiche. author = la personne qui a demandé, target / users.author = la cible.';

const NO_DATA_REPLY = 'Rien sur lui, il est trop insignifiant.';
const BOT_REPLY = "Je fais pas la bio d'un bot, ça m'intéresse pas.";
const COOLDOWN_CLASSEMENT = 'Doucement, le classement va pas s\'évaporer. Réessaie dans un instant.';
const COOLDOWN_FICHE = 'Doucement, une fiche à la fois.';
const HOURLY_FICHE = "J'ai déjà fait mon quota de biographies. Réessaie plus tard.";

const cooldowns = new Map(); // `${command}:${userId}` -> ts
const ficheHourly = []; // timestamps of AI-bound /fiche

function ixPath() {
  return process.env.SLASH_IX_FILE || path.join(DATA_DIR, 'slash-ix.json');
}

function classementPayload() {
  return {
    name: CLASSEMENT,
    description: 'Top 10 des membres les plus actifs (local, sans IA).',
    type: 1,
    dm_permission: false,
    options: [
      {
        type: 3, // STRING
        name: 'periode',
        description: 'Fenêtre de temps (défaut : 7 jours).',
        required: false,
        choices: [
          { name: '7 jours', value: '7j' },
          { name: '30 jours', value: '30j' },
          { name: 'Tout', value: 'tout' },
        ],
      },
      {
        type: 7, // CHANNEL
        name: 'salon',
        description: 'Limiter à un salon.',
        required: false,
        channel_types: [0, 5, 10, 11, 12],
      },
    ],
  };
}

function fichePayload() {
  return {
    name: FICHE,
    description: 'Portrait rôti d\'un membre, à partir de sa mémoire publique (passe par l\'IA).',
    type: 1,
    dm_permission: false,
    options: [
      {
        type: 6, // USER
        name: 'membre',
        description: 'La personne à portraiturer.',
        required: true,
      },
    ],
  };
}

function checkCooldown(command, userId, ms, now = Date.now()) {
  const key = `${command}:${userId}`;
  const last = cooldowns.get(key) || 0;
  if (last && now - last < ms) {
    return { ok: false, reason: 'cooldown', remaining_ms: ms - (now - last) };
  }
  return { ok: true };
}

function markCooldown(command, userId, now = Date.now()) {
  cooldowns.set(command + ':' + userId, now);
}

function checkFicheHourly(now = Date.now()) {
  while (ficheHourly.length && now - ficheHourly[0] > FICHE_HOURLY_MS) ficheHourly.shift();
  if (ficheHourly.length >= FICHE_HOURLY_MAX) {
    return { ok: false, reason: 'hourly_cap', count: ficheHourly.length };
  }
  return { ok: true, count: ficheHourly.length };
}

function markFicheHourly(now = Date.now()) {
  while (ficheHourly.length && now - ficheHourly[0] > FICHE_HOURLY_MS) ficheHourly.shift();
  ficheHourly.push(now);
}

function resetLimitsForTests() {
  cooldowns.clear();
  ficheHourly.length = 0;
}

function periodLabel(period) {
  if (period === '30j') return '30 jours';
  if (period === 'tout') return 'depuis toujours';
  return '7 jours';
}

function buildClassementEmbed({ period = '7j', channelName = null, rows = [] } = {}) {
  const where = channelName ? ` dans #${String(channelName).replace(/^#/, '')}` : '';
  const title = `Le top 10 de ceux qui parlent trop — ${periodLabel(period)}`;
  let description;
  if (!rows.length) {
    description = channelName
      ? `Personne n'a pipé mot${where}. Un silence capital.`
      : `Personne. Le serveur est un désert, bravo. (${periodLabel(period)})`;
  } else {
    const lines = rows.map((r, i) => {
      const name = r.name || r.id;
      const ch = r.top_channel ? ` · ${r.top_channel}` : '';
      const n = r.count === 1 ? '1 message' : `${r.count} messages`;
      return `**${i + 1}.** ${name} — ${n}${ch}`;
    });
    description = (channelName ? `Salon${where}.\n` : '') + lines.join('\n');
  }
  return {
    title: String(title).slice(0, 256),
    description: String(description).slice(0, 4096),
    color: 0x8B0000,
    footer: { text: "Aucune IA n'a été dérangée · t'es pas dans le top ? Logique." },
  };
}

function decideFiche({ target, selfId, isOptedOut, context } = {}) {
  if (!target || !target.id) {
    return { ok: false, reason: 'no_target', reply: NO_DATA_REPLY, ephemeral: false };
  }
  if (target.bot || (selfId && String(target.id) === String(selfId))) {
    return { ok: false, reason: 'bot', reply: BOT_REPLY, ephemeral: false };
  }
  if (typeof isOptedOut === 'function' && isOptedOut(target.id)) {
    return { ok: false, reason: 'optout', reply: NO_DATA_REPLY, ephemeral: false };
  }
  const ctx = typeof context === 'function' ? context(target.id) : context;
  const notes = (ctx && ctx.notes) || [];
  const recent = (ctx && ctx.recent) || [];
  const logged = ctx && ctx.stats && ctx.stats.logged;
  if (!notes.length && !recent.length && !logged) {
    return { ok: false, reason: 'no_data', reply: NO_DATA_REPLY, ephemeral: false };
  }
  return { ok: true, reason: 'ok', context: ctx };
}

function buildFichePayload({
  guildId,
  channelId,
  inAgents,
  requester,
  target,
  targetContext,
  interactionId,
} = {}) {
  const ctx = targetContext || { id: target && target.id, role: 'target', name: null, notes: [], stats: null, recent: [] };
  const subject = { ...ctx, role: 'target' };
  return {
    guild_id: guildId || null,
    channel_id: channelId,
    message_id: null,
    is_dm: false,
    in_agents: Boolean(inAgents),
    author: requester,
    target: {
      id: target.id,
      username: target.username || null,
      display_name: target.display_name || target.globalName || target.username || null,
      bot: Boolean(target.bot),
    },
    content: `Fiche demandée pour ${target.display_name || target.username || target.id} (${target.id}).`,
    users: {
      usage: FICHE_HINT,
      author: subject,
      target: subject,
      others: [],
    },
    interaction: {
      id: String(interactionId),
      command: FICHE,
      token_held: true,
    },
    trigger: 'slash_fiche',
    skills: [],
  };
}

function payloadContainsSecret(payload, token) {
  if (!token) return false;
  return JSON.stringify(payload).includes(token);
}

function loadIx() {
  try {
    const doc = JSON.parse(fs.readFileSync(ixPath(), 'utf8'));
    return doc && typeof doc === 'object' && doc.pending && typeof doc.pending === 'object' ? doc.pending : {};
  } catch {
    return {};
  }
}

function writeIx(pending) {
  const file = ixPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pending }, null, 0), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

function purgePending(now = Date.now()) {
  const pending = loadIx();
  let changed = false;
  for (const [id, rec] of Object.entries(pending)) {
    if (!rec || !rec.expires_at || rec.expires_at <= now) {
      delete pending[id];
      changed = true;
    }
  }
  if (changed) writeIx(pending);
  return pending;
}

function savePending({ id, applicationId, token, channelId, guildId, userId, now = Date.now() }) {
  if (!id || !applicationId || !token) throw new Error('pending interaction needs id, applicationId, token');
  const pending = purgePending(now);
  pending[String(id)] = {
    application_id: String(applicationId),
    token: String(token),
    channel_id: channelId ? String(channelId) : null,
    guild_id: guildId ? String(guildId) : null,
    user_id: userId ? String(userId) : null,
    expires_at: now + INTERACTION_TTL_MS,
  };
  writeIx(pending);
  return { id: String(id), expires_at: pending[String(id)].expires_at };
}

function getPending(id, now = Date.now()) {
  const pending = purgePending(now);
  const rec = pending[String(id)];
  if (!rec) return null;
  if (rec.expires_at <= now) {
    delete pending[String(id)];
    writeIx(pending);
    return null;
  }
  return rec;
}

function deletePending(id) {
  const pending = loadIx();
  if (!pending[String(id)]) return false;
  delete pending[String(id)];
  writeIx(pending);
  return true;
}

function redactToken(text, token) {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('[interaction-token]');
  return s;
}

async function followUpFiche({ applicationId, token, content, dryRun = false } = {}) {
  const text = sanitizeMassMentions(String(content ?? '')).slice(0, 2000);
  if (!text) throw new Error('empty reply');
  if (!applicationId || !token) throw new Error('missing application id or interaction token');
  const body = { content: text, allowed_mentions: allowedMentions() };
  if (dryRun) {
    console.log('dry-run PATCH /webhooks/{application_id}/[interaction-token]/messages/@original');
    console.log(JSON.stringify(body));
    return { ok: true, dryRun: true };
  }
  const url = `https://discord.com/api/v10/webhooks/${encodeURIComponent(applicationId)}/${token}/messages/@original`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    const snippet = redactToken(raw.replace(/\s+/g, ' ').slice(0, 200), token);
    const err = new Error(`interaction follow-up failed (${res.status})`);
    err.status = res.status;
    err.snippet = snippet;
    throw err;
  }
  return { ok: true, dryRun: false };
}

async function registerGuildCommands({ applicationCommands, guildIds, commands, log } = {}) {
  if (!applicationCommands || typeof applicationCommands.fetch !== 'function') {
    throw new Error('applicationCommands is required');
  }
  const payloads = Array.isArray(commands) ? commands : [];
  const ids = [...new Set((guildIds || []).map(String).filter(Boolean))];
  const results = [];
  for (const guildId of ids) {
    const existing = await applicationCommands.fetch({ guildId });
    const list = existing && typeof existing.values === 'function' ? [...existing.values()] : [];
    for (const data of payloads) {
      if (!data || !data.name) continue;
      const found = list.find((c) => c && c.name === data.name);
      if (found) {
        await applicationCommands.edit(found.id, data, guildId);
        if (log) log(`slash /${data.name} registered guild=${guildId} (updated)`);
        results.push({ guildId, name: data.name, action: 'updated', id: found.id });
      } else {
        const created = await applicationCommands.create(data, guildId);
        if (log) log(`slash /${data.name} registered guild=${guildId}`);
        results.push({ guildId, name: data.name, action: 'created', id: created && created.id });
      }
    }
  }
  return results;
}

module.exports = {
  CLASSEMENT,
  FICHE,
  CLASSEMENT_COOLDOWN_MS,
  FICHE_COOLDOWN_MS,
  FICHE_HOURLY_MAX,
  FICHE_HOURLY_MS,
  FICHE_HINT,
  NO_DATA_REPLY,
  BOT_REPLY,
  COOLDOWN_CLASSEMENT,
  COOLDOWN_FICHE,
  HOURLY_FICHE,
  classementPayload,
  fichePayload,
  checkCooldown,
  markCooldown,
  checkFicheHourly,
  markFicheHourly,
  resetLimitsForTests,
  periodLabel,
  buildClassementEmbed,
  decideFiche,
  buildFichePayload,
  payloadContainsSecret,
  savePending,
  getPending,
  deletePending,
  purgePending,
  followUpFiche,
  redactToken,
  registerGuildCommands,
};
