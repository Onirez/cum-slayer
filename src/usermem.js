'use strict';

/**
 * Per-user memory for the bridge.
 *
 *   data/users/<id>.log.jsonl   rolling log of the user's guild messages
 *                               (last USERMEM_KEEP lines, content <= 500 chars)
 *   data/users/<id>.notes.json  short factual notes the routine writes
 *   data/users/_optout.json     ids that asked not to be logged
 *   data/users/_throwback.json  last throwback time per user (rate limit)
 *
 * Only guild messages are logged (never DMs). Low RAM: appends are async,
 * only a per-user line counter lives in memory, compaction is per file.
 * No secrets are read or written here.
 */

const fs = require('fs');
const path = require('path');

let DATA_DIR;
try { DATA_DIR = require('./config').DATA_DIR; } catch { DATA_DIR = path.join(__dirname, 'data'); }

const KEEP = Math.max(20, Number(process.env.USERMEM_KEEP || 400));
const SELF_BOT_ID = process.env.BOT_APP_ID || '1574150367325855856';
const COMPACT_AT = Math.round(KEEP * 1.25);
const MAX_FILE_BYTES = Number(process.env.USERMEM_MAX_FILE_BYTES || 384 * 1024);
const CONTENT_MAX = 500;
const NOTE_MAX = 200;
const NOTES_MAX = 30;
const NOTES_TOTAL_MAX = 3000;
const ID_RE = /^\d{5,30}$/;

function usersDir() {
  return process.env.USERMEM_DIR || path.join(DATA_DIR, 'users');
}
function logPath(id) { return path.join(usersDir(), `${id}.log.jsonl`); }
function notesPath(id) { return path.join(usersDir(), `${id}.notes.json`); }
function optoutPath() { return path.join(usersDir(), '_optout.json'); }

function assertId(id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('user id must be a numeric Discord snowflake');
  return String(id);
}

function truncate(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Never keep anything that looks like a Discord token in the logs.
const TOKEN_RE = /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}/g;
function scrub(text) {
  return String(text ?? '').replace(TOKEN_RE, '[token masqué]').replace(/\s+/g, ' ').trim();
}

// ---- opt-out ----
let optoutCache = null;
function loadOptout() {
  if (optoutCache) return optoutCache;
  try { optoutCache = new Set(JSON.parse(fs.readFileSync(optoutPath(), 'utf8')).ids || []); } catch { optoutCache = new Set(); }
  return optoutCache;
}
function isOptedOut(id) { return loadOptout().has(String(id)); }
function setOptout(id, on) {
  const set = new Set(loadOptoutFresh());
  if (on) set.add(String(id)); else set.delete(String(id));
  fs.mkdirSync(usersDir(), { recursive: true });
  atomicWrite(optoutPath(), JSON.stringify({ ids: [...set] }));
  optoutCache = set;
}
function loadOptoutFresh() {
  optoutCache = null;
  return loadOptout();
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---- log ----
function readLog(id) {
  let raw;
  try { raw = fs.readFileSync(logPath(id), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

function writeLog(id, entries) {
  fs.mkdirSync(usersDir(), { recursive: true });
  const kept = entries.slice(-KEEP);
  atomicWrite(logPath(id), kept.length ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n` : '');
  return kept.length;
}

/** Build a compact log entry from plain fields (shared by live + backfill). */
function makeEntry({ messageId, channelId, channelName, timestamp, content, attachments = 0, replyTo = null, replyToUser = null, name = null, bot = false, light = false }) {
  const e = {
    m: String(messageId),
    t: Number(timestamp) || Date.now(),
    ch: String(channelId),
  };
  if (channelName) e.cn = truncate(channelName, 40);
  if (name) e.n = truncate(name, 40);
  if (bot) e.b = 1;
  if (light) return e; // count-only: no content, replies, or attachments
  let c = scrub(content);
  if (attachments) c = `${c}${c ? ' ' : ''}[${attachments} pièce(s) jointe(s)]`;
  e.c = truncate(c, CONTENT_MAX);
  if (replyTo) e.r = String(replyTo);
  if (replyToUser) e.ru = String(replyToUser);
  return e;
}

const counts = new Map(); // id -> approximate line count
const chains = new Map(); // id -> promise (serialize writes per user)

function serialize(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  chains.set(id, tail);
  tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return next;
}

async function countLines(id) {
  if (counts.has(id)) return counts.get(id);
  let n = 0;
  try {
    const raw = await fs.promises.readFile(logPath(id), 'utf8');
    for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) n++;
  } catch { n = 0; }
  counts.set(id, n);
  return n;
}

/** Append one entry; compacts to the last KEEP lines when over cap. */
function append(userId, entry) {
  const id = assertId(userId);
  if (isOptedOut(id)) return Promise.resolve(false);
  return serialize(id, async () => {
    await fs.promises.mkdir(usersDir(), { recursive: true });
    const n = (await countLines(id)) + 1;
    await fs.promises.appendFile(logPath(id), `${JSON.stringify(entry)}\n`);
    counts.set(id, n);
    let size = 0;
    if (n % 25 === 0 || n >= COMPACT_AT) {
      try { size = (await fs.promises.stat(logPath(id))).size; } catch { size = 0; }
    }
    if (n >= COMPACT_AT || size > MAX_FILE_BYTES) {
      let entries = readLog(id);
      if (size > MAX_FILE_BYTES) {
        // keep the newest entries that fit in ~3/4 of the byte cap
        let bytes = 0;
        const kept = [];
        for (let i = entries.length - 1; i >= 0 && kept.length < KEEP; i--) {
          bytes += JSON.stringify(entries[i]).length + 1;
          if (bytes > MAX_FILE_BYTES * 0.75) break;
          kept.unshift(entries[i]);
        }
        entries = kept;
      }
      counts.set(id, writeLog(id, entries));
    }
    return true;
  });
}

/** Record a discord.js Message (guild only, never DMs). Own-bot messages
 *  are stored as light count-only entries for /stats (no content). */
function recordMessage(message, { selfId } = {}) {
  if (!message || !message.guildId || !message.author) return Promise.resolve(false);
  const isSelf = Boolean(selfId && String(message.author.id) === String(selfId));
  if (isSelf) {
    const entry = makeEntry({
      messageId: message.id,
      channelId: message.channelId,
      channelName: message.channel?.name || null,
      timestamp: message.createdTimestamp,
      name: message.member?.displayName || message.author.globalName || message.author.username,
      bot: true,
      light: true,
    });
    return append(message.author.id, entry);
  }
  const content = typeof message.cleanContent === 'string' ? message.cleanContent : (message.content || '');
  const hasEmbedsOnly = !content && message.embeds?.length;
  const entry = makeEntry({
    messageId: message.id,
    channelId: message.channelId,
    channelName: message.channel?.name || null,
    timestamp: message.createdTimestamp,
    content: hasEmbedsOnly ? '[embed]' : content,
    attachments: message.attachments?.size || 0,
    replyTo: message.reference?.messageId || null,
    replyToUser: message.mentions?.repliedUser?.id || null,
    name: message.member?.displayName || message.author.globalName || message.author.username,
    bot: Boolean(message.author.bot),
  });
  return append(message.author.id, entry);
}

/** Merge entries (backfill): dedupe by message id, sort by time, keep KEEP. */
function mergeEntries(userId, entries) {
  const id = assertId(userId);
  if (isOptedOut(id)) return Promise.resolve(0);
  return serialize(id, async () => {
    const byId = new Map();
    for (const e of readLog(id)) byId.set(e.m, e);
    for (const e of entries) if (!byId.has(e.m)) byId.set(e.m, e);
    const all = [...byId.values()].sort((a, b) => a.t - b.t);
    const n = writeLog(id, all);
    counts.set(id, n);
    return n;
  });
}

// ---- notes ----
function readNotes(userId) {
  const id = assertId(userId);
  try {
    const doc = JSON.parse(fs.readFileSync(notesPath(id), 'utf8'));
    return { userId: id, notes: Array.isArray(doc.notes) ? doc.notes : [], updatedAt: doc.updatedAt || null };
  } catch {
    return { userId: id, notes: [], updatedAt: null };
  }
}

// Refuse obvious doxxing / sensitive data in notes.
const SENSITIVE = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'adresse e-mail'],
  [/(?:\+?\d[\s.-]?){9,}/, 'numéro de téléphone ou identifiant'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'adresse IP'],
  [/\b\d{1,4}\s*(?:,\s*)?(?:rue|avenue|av\.|boulevard|bd|chemin|allée|impasse|place|route|street|st\.|road)\b/i, 'adresse postale'],
  [/\b(?:mot de passe|password|mdp|iban|carte bancaire|token|code postal)\b/i, 'donnée sensible'],
  [TOKEN_RE, 'token'],
];
function sensitiveReason(text) {
  for (const [re, label] of SENSITIVE) {
    re.lastIndex = 0;
    if (re.test(text)) return label;
  }
  return null;
}

function addNote(userId, byId, text, { dryRun = false } = {}) {
  const id = assertId(userId);
  if (id === String(SELF_BOT_ID)) return { userId: id, saved: false, reason: 'refused: no AI notes on the bot itself' };
  const by = byId ? assertId(byId) : null;
  const clean = scrub(text);
  if (!clean) throw new Error('note is empty');
  if (clean.length > NOTE_MAX) throw new Error(`note must be at most ${NOTE_MAX} characters (got ${clean.length})`);
  const bad = sensitiveReason(clean);
  if (bad) return { userId: id, saved: false, reason: `refused: looks like ${bad} (never store personal/sensitive data)` };
  const doc = readNotes(id);
  if (doc.notes.some((n) => n.text.toLowerCase() === clean.toLowerCase())) {
    return { userId: id, saved: false, reason: 'duplicate note', notes: doc.notes };
  }
  const nextId = doc.notes.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0) + 1;
  const note = { id: nextId, text: clean, at: new Date().toISOString() };
  if (by && by !== id) note.by = by;
  const notes = [...doc.notes, note];
  const dropped = [];
  while (notes.length > NOTES_MAX || notes.reduce((s, n) => s + n.text.length, 0) > NOTES_TOTAL_MAX) dropped.push(notes.shift());
  if (dryRun) return { userId: id, saved: false, dryRun: true, wouldSave: note, wouldDrop: dropped };
  fs.mkdirSync(usersDir(), { recursive: true });
  const updatedAt = new Date().toISOString();
  atomicWrite(notesPath(id), JSON.stringify({ userId: id, notes, updatedAt }, null, 1));
  return { userId: id, saved: true, note, dropped, count: notes.length };
}

function removeNote(userId, noteId, { dryRun = false } = {}) {
  const id = assertId(userId);
  const doc = readNotes(id);
  const notes = doc.notes.filter((n) => String(n.id) !== String(noteId));
  if (notes.length === doc.notes.length) return { userId: id, removed: false, reason: 'no such note' };
  if (dryRun) return { userId: id, removed: false, dryRun: true };
  atomicWrite(notesPath(id), JSON.stringify({ userId: id, notes, updatedAt: new Date().toISOString() }, null, 1));
  return { userId: id, removed: true, count: notes.length };
}

/** Delete stored data. what: all | notes | history. Legacy memory too on all. */
async function forget(userId, what = 'all', { dryRun = false, legacyMemoryDir } = {}) {
  const id = assertId(userId);
  const targets = [];
  if (what === 'all' || what === 'history') targets.push(logPath(id));
  if (what === 'all' || what === 'notes') targets.push(notesPath(id));
  if (what === 'all') targets.push(path.join(legacyMemoryDir || path.join(DATA_DIR, 'memory'), `${id}.json`));
  const existing = targets.filter((p) => fs.existsSync(p)).map((p) => path.basename(p));
  if (dryRun) return { userId: id, dryRun: true, wouldDelete: existing };
  await serialize(id, async () => {
    for (const p of targets) { try { fs.unlinkSync(p); } catch { /* absent */ } }
    counts.delete(id);
  });
  return { userId: id, deleted: existing };
}

// ---- reading for the payload / lookups ----
function fmtTime(t) {
  try {
    return new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris', hour12: false }).slice(0, 16);
  } catch { return new Date(t).toISOString().slice(0, 16); }
}

function compactEntry(e, max = 300) {
  const o = { t: fmtTime(e.t), ch: e.cn ? `#${e.cn}` : e.ch, c: truncate(e.c, max) };
  if (e.ru) o.re = e.ru;
  return o;
}

function history(userId, { limit = 20, channelId = null, search = null, excludeId = null, max = 300 } = {}) {
  const id = assertId(userId);
  let entries = readLog(id);
  if (excludeId) entries = entries.filter((e) => e.m !== String(excludeId));
  if (channelId) entries = entries.filter((e) => e.ch === String(channelId));
  if (search) {
    const q = String(search).toLowerCase();
    entries = entries.filter((e) => String(e.c).toLowerCase().includes(q));
  }
  const total = entries.length;
  const n = Math.max(1, Math.min(KEEP, Number(limit) || 20));
  return { total, items: entries.slice(-n).map((e) => compactEntry(e, max)) };
}

function stats(entries) {
  if (!entries.length) return null;
  const byCh = new Map();
  for (const e of entries) {
    const k = e.cn ? `#${e.cn}` : e.ch;
    byCh.set(k, (byCh.get(k) || 0) + 1);
  }
  const top = [...byCh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  return { logged: entries.length, first: fmtTime(entries[0].t), last: fmtTime(entries[entries.length - 1].t), top_channels: top };
}

/** Compact per-user context block for the webhook payload. */
function contextFor(userId, { limit = 20, excludeId = null, max = 300, role = 'author' } = {}) {
  const id = assertId(userId);
  const all = readLog(id);
  const entries = excludeId ? all.filter((e) => e.m !== String(excludeId)) : all;
  const notes = readNotes(id).notes.map((n) => (n.by ? `${n.text} (selon <@${n.by}>)` : n.text));
  const lastName = [...all].reverse().find((e) => e.n)?.n || null;
  return {
    id,
    role,
    name: lastName,
    opted_out: isOptedOut(id) || undefined,
    notes,
    stats: stats(all),
    recent: entries.slice(-limit).map((e) => compactEntry(e, max)),
  };
}

const PERIOD_MS = {
  '7j': 7 * 24 * 60 * 60 * 1000,
  '30j': 30 * 24 * 60 * 60 * 1000,
  tout: null,
};

/**
 * Top-N most active members from usermem logs, including other bots and
 * this bot (`selfId`, always marked `bot: true`). Skips opted-out users.
 * Optional period ('7j' | '30j' | 'tout') and channel id. Pure disk read.
 */
function leaderboard({ period = '7j', channelId = null, limit = 10, now = Date.now(), selfId = null } = {}) {
  const key = Object.prototype.hasOwnProperty.call(PERIOD_MS, period) ? period : '7j';
  const window = PERIOD_MS[key];
  const since = window == null ? null : now - window;
  const ch = channelId ? String(channelId) : null;
  let files = [];
  try { files = fs.readdirSync(usersDir()); } catch { return { period: key, since, channel_id: ch, rows: [] }; }
  const ids = new Set();
  for (const f of files) {
    const m = f.match(/^(\d{5,30})\.log\.jsonl$/);
    if (m) ids.add(m[1]);
  }
  const rows = [];
  for (const id of ids) {
    if (isOptedOut(id)) continue;
    const all = readLog(id);
    const isSelf = Boolean(selfId && id === String(selfId));
    const isBot = isSelf || all.some((e) => e && e.b);
    const entries = all.filter((e) => {
      if (since != null && !(Number(e.t) >= since)) return false;
      if (ch && e.ch !== ch) return false;
      return true;
    });
    if (!entries.length) continue;
    const byCh = new Map();
    for (const e of entries) {
      const k = e.cn ? `#${e.cn}` : e.ch;
      byCh.set(k, (byCh.get(k) || 0) + 1);
    }
    const top = [...byCh.entries()].sort((a, b) => b[1] - a[1])[0];
    const name = [...entries].reverse().find((e) => e.n)?.n
      || [...all].reverse().find((e) => e.n)?.n
      || null;
    const row = {
      id,
      name,
      count: entries.length,
      top_channel: top ? top[0] : null,
    };
    if (isBot) row.bot = true;
    rows.push(row);
  }
  rows.sort((a, b) => b.count - a.count || String(a.name || a.id).localeCompare(String(b.name || b.id)));
  const n = Math.max(1, Math.min(25, Number(limit) || 10));
  return { period: key, since, channel_id: ch, rows: rows.slice(0, n) };
}

function listUsers(limit = 30) {
  let files = [];
  try { files = fs.readdirSync(usersDir()); } catch { return []; }
  const ids = new Set();
  for (const f of files) { const m = f.match(/^(\d{5,30})\.(log\.jsonl|notes\.json)$/); if (m) ids.add(m[1]); }
  const out = [];
  for (const id of ids) {
    const entries = readLog(id);
    const last = entries[entries.length - 1];
    out.push({ id, name: [...entries].reverse().find((e) => e.n)?.n || null, logged: entries.length, notes: readNotes(id).notes.length, last: last ? fmtTime(last.t) : null, _t: last ? last.t : 0 });
  }
  return out.sort((a, b) => b._t - a._t).slice(0, limit).map(({ _t, ...rest }) => rest);
}

// ---- throwback ("vieux message"): rare callback to an older message ----
const THROWBACK_RATE = Math.max(1, Number(process.env.USERMEM_THROWBACK_RATE || 17)); // ~1 in N eligible triggers
const THROWBACK_COOLDOWN_MS = Number(process.env.USERMEM_THROWBACK_COOLDOWN_MS || 20 * 3600 * 1000);
const THROWBACK_MIN_AGE_MS = Number(process.env.USERMEM_THROWBACK_MIN_AGE_MS || 3 * 24 * 3600 * 1000);
const THROWBACK_SKIP_RECENT = 15;
function throwbackPath() { return path.join(usersDir(), '_throwback.json'); }

/** Is this text worth a callback? Not link-only, emoji-only, or too short. */
function substantive(text) {
  const t = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<a?:\w+:\d+>/g, ' ')
    .replace(/\[\d+ pièce\(s\) jointe\(s\)\]|\[embed\]|\[token masqué\]/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}\uFE0F]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const letters = (t.match(/\p{L}/gu) || []).length;
  const words = t.split(' ').filter((w) => /\p{L}{2,}/u.test(w)).length;
  return letters >= 20 && words >= 4;
}

function readThrowbackState() {
  try { return JSON.parse(fs.readFileSync(throwbackPath(), 'utf8')) || {}; } catch { return {}; }
}

/** Candidates: older than the recent window and older than MIN_AGE, substantive. */
function throwbackCandidates(userId, { now = Date.now() } = {}) {
  const entries = readLog(assertId(userId));
  return entries.slice(0, Math.max(0, entries.length - THROWBACK_SKIP_RECENT))
    .filter((e) => now - e.t >= THROWBACK_MIN_AGE_MS && substantive(e.c));
}

/**
 * Maybe pick one old message for a callback. Rare: ~1/THROWBACK_RATE rolls,
 * at most once per user per cooldown (persisted). Returns {t, ch, c} or null.
 */
function maybeThrowback(userId, { now = Date.now(), rand = Math.random, force = false, dryRun = false } = {}) {
  const id = assertId(userId);
  const state = readThrowbackState();
  const last = Number(state[id] || 0);
  if (!force && now - last < THROWBACK_COOLDOWN_MS) return null;
  if (!force && rand() >= 1 / THROWBACK_RATE) return null;
  const cands = throwbackCandidates(id, { now });
  if (!cands.length) return null;
  const e = cands[Math.floor(rand() * cands.length) % cands.length];
  if (!dryRun) {
    const next = {};
    for (const [k, v] of Object.entries(state)) if (now - Number(v) < 2 * THROWBACK_COOLDOWN_MS) next[k] = v;
    next[id] = now;
    try {
      fs.mkdirSync(usersDir(), { recursive: true });
      atomicWrite(throwbackPath(), JSON.stringify(next));
    } catch { /* best effort */ }
  }
  return { t: fmtTime(e.t), ch: e.cn ? `#${e.cn}` : e.ch, c: truncate(e.c, 300) };
}

function flush() {
  return Promise.all([...chains.values()]);
}

module.exports = {
  KEEP, CONTENT_MAX, NOTE_MAX, NOTES_MAX,
  usersDir, logPath, notesPath, assertId, scrub, makeEntry,
  append, recordMessage, mergeEntries, readLog,
  readNotes, addNote, removeNote, forget, sensitiveReason,
  isOptedOut, setOptout, loadOptoutFresh,
  history, contextFor, listUsers, leaderboard, PERIOD_MS, flush, fmtTime,
  substantive, throwbackCandidates, maybeThrowback, THROWBACK_RATE,
};
