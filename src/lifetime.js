'use strict';

/**
 * Cheap all-time counters on the data volume: trigger types, incoming
 * images vs videos, optional /stats uses, and a monotonic "messages read
 * forever" count (independent of the 400/member storage cap).
 * Writes are debounced and flushed on shutdown. Message ids are remembered
 * so restarts and backfills do not double-count.
 */

const fs = require('fs');
const path = require('path');

function debounceMs() { return Math.max(50, Number(process.env.LIFETIME_FLUSH_MS || 5_000) || 5_000); }
function flushEvery() { return Math.max(1, Number(process.env.LIFETIME_FLUSH_EVERY || 25) || 25); }
function recentKeep() { return Math.max(100, Number(process.env.LIFETIME_RECENT_IDS || 40_000) || 40_000); }
const DEBOUNCE_MS = debounceMs();
const FLUSH_EVERY = flushEvery();
const RECENT_KEEP = recentKeep();

function dataDir() {
  try {
    const c = require('./config');
    if (c && c.DATA_DIR) return c.DATA_DIR;
  } catch { /* live tree has no config.js */ }
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.LIFETIME_FILE) return path.dirname(process.env.LIFETIME_FILE);
  if (fs.existsSync(path.join(__dirname, 'bridge.js'))) return path.join(__dirname, 'data');
  return path.join(__dirname, '..', 'data');
}

function filePath() {
  return process.env.LIFETIME_FILE || path.join(dataDir(), 'lifetime.json');
}

function usersDirDefault() {
  if (process.env.USERMEM_DIR) return process.env.USERMEM_DIR;
  return path.join(dataDir(), 'users');
}

const EMPTY = {
  startedAt: null,
  triggers: {},
  images: 0,
  videos: 0,
  stats: 0,
  messagesRead: 0,
  messagesReadSeededAt: null,
  messagesReadSeedCount: 0,
};

let state = null;
let dirty = false;
let timer = null;
let unsaved = 0;
let hooksInstalled = false;

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function asIdList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const id = String(x || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalize(doc) {
  const src = doc && typeof doc === 'object' ? doc : {};
  const seedIds = asIdList(src.seedIds || src.messagesReadSeedIds);
  const recentIds = asIdList(src.recentIds || src.messagesReadRecentIds);
  const triggers = {};
  if (src.triggers && typeof src.triggers === 'object') {
    for (const [k, v] of Object.entries(src.triggers)) {
      const key = String(k || '').trim();
      if (!key) continue;
      triggers[key] = Math.max(0, Number(v) || 0);
    }
  }
  return {
    startedAt: Number.isFinite(Number(src.startedAt)) ? Number(src.startedAt) : null,
    triggers,
    images: Math.max(0, Number(src.images) || 0),
    videos: Math.max(0, Number(src.videos) || 0),
    stats: Math.max(0, Number(src.stats) || 0),
    messagesRead: Math.max(0, toInt(src.messagesRead, 0)),
    messagesReadSeededAt: Number.isFinite(Number(src.messagesReadSeededAt)) ? Number(src.messagesReadSeededAt) : null,
    messagesReadSeedCount: Math.max(0, toInt(src.messagesReadSeedCount, 0)),
    seedIds,
    recentIds,
  };
}

function hydrate(doc) {
  const n = normalize(doc);
  n.seedSet = new Set(n.seedIds);
  n.seen = new Set(n.seedIds);
  for (const id of n.recentIds) n.seen.add(id);
  return n;
}

function publicView(s) {
  if (!s) return normalize(EMPTY);
  return {
    startedAt: s.startedAt,
    triggers: { ...s.triggers },
    images: s.images,
    videos: s.videos,
    stats: s.stats,
    messagesRead: s.messagesRead,
    messagesReadSeededAt: s.messagesReadSeededAt,
    messagesReadSeedCount: s.messagesReadSeedCount,
  };
}

function readDisk() {
  try {
    return hydrate(JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch {
    return hydrate(EMPTY);
  }
}

function ensure() {
  if (!state) state = readDisk();
  return state;
}

function load() {
  return publicView(ensure());
}

function persistable(s) {
  return {
    startedAt: s.startedAt,
    triggers: s.triggers,
    images: s.images,
    videos: s.videos,
    stats: s.stats,
    messagesRead: s.messagesRead,
    messagesReadSeededAt: s.messagesReadSeededAt,
    messagesReadSeedCount: s.messagesReadSeedCount,
    seedIds: s.seedIds,
    recentIds: s.recentIds.length > recentKeep() ? s.recentIds.slice(-recentKeep()) : s.recentIds,
  };
}

function atomicWrite(doc) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!dirty || !state) return true;
  try {
    atomicWrite(persistable(state));
    dirty = false;
    unsaved = 0;
    return true;
  } catch {
    return false;
  }
}

function scheduleFlush() {
  dirty = true;
  unsaved += 1;
  if (unsaved >= flushEvery()) {
    flush();
    return;
  }
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, debounceMs());
  if (timer.unref) timer.unref();
}

function markDirty() {
  const s = ensure();
  if (!s.startedAt) s.startedAt = Date.now();
  scheduleFlush();
  return s;
}

function collectStoredMessageIds(dir) {
  const ids = [];
  const seen = new Set();
  let entries = 0;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { ids, entries, unique: 0 }; }
  for (const f of files) {
    if (!f.endsWith('.log.jsonl')) continue;
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      entries += 1;
      const id = e && e.m != null ? String(e.m).trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, entries, unique: ids.length };
}

function ensureSeeded(usersDir) {
  const s = ensure();
  if (s.messagesReadSeededAt) return publicView(s);
  const collected = collectStoredMessageIds(usersDir || usersDirDefault());
  // Never start below the stock: use the number of logged entries (≈ unique ids).
  const seedTotal = Math.max(collected.entries, collected.unique, s.messagesRead || 0);
  s.messagesRead = seedTotal;
  s.messagesReadSeedCount = seedTotal;
  s.messagesReadSeededAt = Date.now();
  if (!s.startedAt) s.startedAt = s.messagesReadSeededAt;
  s.seedIds = collected.ids.slice();
  s.seedSet = new Set(collected.ids);
  for (const id of collected.ids) s.seen.add(id);
  dirty = true;
  unsaved = FLUSH_EVERY; // persist the seed immediately
  flush();
  return publicView(s);
}

function rememberRecent(s, id) {
  s.recentIds.push(id);
  s.seen.add(id);
  while (s.recentIds.length > recentKeep()) {
    const drop = s.recentIds.shift();
    if (drop && !s.seedSet.has(drop)) s.seen.delete(drop);
  }
}

function noteGuildMessage(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return { counted: false, total: ensure().messagesRead };
  const s = ensure();
  if (!s.messagesReadSeededAt) ensureSeeded();
  if (s.seen.has(id)) return { counted: false, total: s.messagesRead };
  rememberRecent(s, id);
  if (s.seedSet.has(id)) return { counted: false, total: s.messagesRead };
  s.messagesRead += 1;
  markDirty();
  return { counted: true, total: s.messagesRead };
}

function bumpTrigger(type) {
  const key = String(type || '').trim();
  if (!key) return load();
  const s = markDirty();
  s.triggers[key] = (s.triggers[key] || 0) + 1;
  return publicView(s);
}

function bumpMedia({ images = 0, videos = 0 } = {}) {
  const img = Math.max(0, Number(images) || 0);
  const vid = Math.max(0, Number(videos) || 0);
  if (!img && !vid) return load();
  const s = markDirty();
  s.images += img;
  s.videos += vid;
  return publicView(s);
}

function bumpStats() {
  const s = markDirty();
  s.stats += 1;
  return publicView(s);
}

function hasData(doc) {
  if (!doc) return false;
  if (doc.startedAt) return true;
  if (doc.images || doc.videos || doc.stats || doc.messagesRead) return true;
  if (doc.messagesReadSeededAt) return true;
  return Object.values(doc.triggers || {}).some((n) => n > 0);
}

function resetForTests() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  state = null;
  dirty = false;
  unsaved = 0;
}

function installFlushHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const run = () => { try { flush(); } catch { /* ignore */ } };
  process.on('exit', run);
  process.on('beforeExit', run);
  process.on('SIGTERM', run);
  process.on('SIGINT', run);
}

installFlushHooks();

module.exports = {
  filePath,
  load,
  flush,
  bumpTrigger,
  bumpMedia,
  bumpStats,
  noteGuildMessage,
  ensureSeeded,
  hasData,
  normalize,
  resetForTests,
  collectStoredMessageIds,
  DEBOUNCE_MS,
  FLUSH_EVERY,
  RECENT_KEEP,
};
