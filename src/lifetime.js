'use strict';

/**
 * Cheap all-time counters on the data volume: trigger types, incoming
 * images vs videos, and optional /stats uses. Not a command log for
 * /fiche or the retired /classement.
 */

const fs = require('fs');
const path = require('path');

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

const EMPTY = {
  startedAt: null,
  triggers: {},
  images: 0,
  videos: 0,
  stats: 0,
};

function normalize(doc) {
  const out = {
    startedAt: doc && Number.isFinite(Number(doc.startedAt)) ? Number(doc.startedAt) : null,
    triggers: {},
    images: Math.max(0, Number(doc && doc.images) || 0),
    videos: Math.max(0, Number(doc && doc.videos) || 0),
    stats: Math.max(0, Number(doc && doc.stats) || 0),
  };
  const src = doc && doc.triggers && typeof doc.triggers === 'object' ? doc.triggers : {};
  for (const [k, v] of Object.entries(src)) {
    const key = String(k || '').trim();
    if (!key) continue;
    out.triggers[key] = Math.max(0, Number(v) || 0);
  }
  return out;
}

function load() {
  try {
    const doc = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return normalize(doc);
  } catch {
    return normalize(EMPTY);
  }
}

function atomicWrite(doc) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, file);
}

function mutate(fn) {
  const doc = load();
  if (!doc.startedAt) doc.startedAt = Date.now();
  fn(doc);
  try {
    atomicWrite(doc);
    return doc;
  } catch (err) {
    return doc;
  }
}

function bumpTrigger(type) {
  const key = String(type || '').trim();
  if (!key) return load();
  return mutate((doc) => {
    doc.triggers[key] = (doc.triggers[key] || 0) + 1;
  });
}

function bumpMedia({ images = 0, videos = 0 } = {}) {
  const img = Math.max(0, Number(images) || 0);
  const vid = Math.max(0, Number(videos) || 0);
  if (!img && !vid) return load();
  return mutate((doc) => {
    doc.images += img;
    doc.videos += vid;
  });
}

function bumpStats() {
  return mutate((doc) => {
    doc.stats += 1;
  });
}

function hasData(doc) {
  if (!doc) return false;
  if (doc.startedAt) return true;
  if (doc.images || doc.videos || doc.stats) return true;
  return Object.values(doc.triggers || {}).some((n) => n > 0);
}

module.exports = {
  filePath,
  load,
  bumpTrigger,
  bumpMedia,
  bumpStats,
  hasData,
  normalize,
};
