'use strict';

/**
 * Aggregate stored usermem + recent triggers + lifetime counters.
 * Totals are what is stored (capped at 400 messages/member), not everything ever read.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SELF_ID = '1574150367325855856';
const TZ = 'Europe/Paris';
const KEEP_CAP = 400;
const ATTACH_RE = /\[(\d+)\s*pièce\(s\)\s*jointe\(s\)\]/;
const DOW_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function defaultSelfId() {
  try {
    const c = require('./config');
    if (c && c.BOT_APP_ID) return String(c.BOT_APP_ID);
  } catch { /* live tree */ }
  return process.env.BOT_APP_ID || DEFAULT_SELF_ID;
}

function usersDirFrom(root) {
  if (process.env.USERMEM_DIR) return process.env.USERMEM_DIR;
  if (root) return path.join(root, 'users');
  try {
    const c = require('./config');
    if (c && c.DATA_DIR) return path.join(c.DATA_DIR, 'users');
  } catch { /* live */ }
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'users');
  if (fs.existsSync(path.join(__dirname, 'bridge.js'))) return path.join(__dirname, 'data', 'users');
  return path.join(__dirname, '..', 'data', 'users');
}

function dataRootFrom(usersDir) {
  return path.dirname(usersDir);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let parisFmt = null;
function parisParts(ms) {
  const d = new Date(ms);
  if (!parisFmt) {
    parisFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
  }
  const parts = parisFmt.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const map = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    dow: map[get('weekday')] ?? 0,
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function fmtParis(ms, withTime = true) {
  const p = parisParts(ms);
  const mon = MONTHS_SHORT[p.month - 1] || `${p.month}`;
  const day = String(p.day);
  const date = `${day} ${mon} ${p.year}`;
  if (!withTime) return date;
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${date} ${hh}:${mm}`;
}

function frNum(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function displayName(entries) {
  const counts = new Map();
  for (const e of entries) {
    if (!e || !e.n) continue;
    counts.set(e.n, (counts.get(e.n) || 0) + 1);
  }
  let best = null;
  let bestN = -1;
  for (const [n, c] of counts) {
    if (c > bestN) {
      best = n;
      bestN = c;
    }
  }
  return best;
}

function isBot(uid, entries, selfId) {
  if (String(uid) === String(selfId)) return true;
  if (!entries.length) return false;
  let bots = 0;
  for (const e of entries) if (e && e.b) bots++;
  return bots >= entries.length * 0.5;
}

function loadLogs(dir) {
  const users = new Map();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return users; }
  for (const f of files) {
    const m = f.match(/^(\d{5,30})\.log\.jsonl$/);
    if (!m) continue;
    const entries = [];
    let raw = '';
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip */ }
    }
    users.set(m[1], entries);
  }
  return users;
}

function countNotes(dir) {
  let n = 0;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.notes.json')) continue;
    const doc = readJson(path.join(dir, f), null);
    if (doc && Array.isArray(doc.notes)) n += doc.notes.length;
  }
  return n;
}

function countMemory(dir) {
  let n = 0;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return 0; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    n += 1;
  }
  return n;
}

function plainChannelName(cn, ch) {
  const raw = String(cn || '').trim();
  if (!raw) return ch ? String(ch) : '?';
  const stripped = raw
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, '')
    .replace(/^[┃\s|]+/u, '')
    .trim();
  return stripped || raw;
}

function computeStats({
  usersDir,
  dataDir,
  triggersFile,
  lifetime,
  selfId,
  now = Date.now(),
} = {}) {
  const uidSelf = String(selfId || defaultSelfId());
  const uDir = usersDir || usersDirFrom(dataDir);
  const root = dataDir || dataRootFrom(uDir);
  const users = loadLogs(uDir);

  const talkers = [];
  let total = 0;
  let humanMsgs = 0;
  let botMsgs = 0;
  let humanUsers = 0;
  let botUsers = 0;
  let oldest = null;
  let newest = null;
  const hours = Array.from({ length: 24 }, () => 0);
  const dows = Array.from({ length: 7 }, () => 0);
  const perDay = new Map();
  const channels = new Map();
  const channelNames = new Map();
  const replyToBot = new Map();
  let lengths = [];
  let attachMsgs = 0;
  let attachUnits = 0;
  let at500 = 0;
  let heartTotal = 0;
  let heartMaxOne = 0;
  let heartMaxAuthor = null;
  const selfChans = new Map();
  const botMsgIds = new Set();

  const selfEntries = users.get(uidSelf) || [];
  for (const e of selfEntries) if (e && e.m) botMsgIds.add(String(e.m));

  for (const [uid, entries] of users) {
    const bot = isBot(uid, entries, uidSelf);
    const name = displayName(entries) || uid;
    const n = entries.length;
    total += n;
    if (bot) {
      botUsers += 1;
      botMsgs += n;
    } else {
      humanUsers += 1;
      humanMsgs += n;
    }
    talkers.push({ id: uid, name, count: n, bot, atCap: n >= KEEP_CAP });

    for (const e of entries) {
      if (!e) continue;
      if (typeof e.t === 'number') {
        if (oldest === null || e.t < oldest) oldest = e.t;
        if (newest === null || e.t > newest) newest = e.t;
        const p = parisParts(e.t);
        hours[p.hour] += 1;
        dows[p.dow] += 1;
        perDay.set(p.dateStr, (perDay.get(p.dateStr) || 0) + 1);
      }
      const ch = e.ch || '?';
      channels.set(ch, (channels.get(ch) || 0) + 1);
      if (e.cn) channelNames.set(ch, e.cn);
      if (uid === uidSelf) {
        const key = e.cn || ch;
        selfChans.set(key, (selfChans.get(key) || 0) + 1);
      }
      if (uid !== uidSelf) {
        const ru = e.ru != null ? String(e.ru) : '';
        const r = e.r != null ? String(e.r) : '';
        if (ru === uidSelf || (r && botMsgIds.has(r))) {
          const rec = replyToBot.get(uid) || { id: uid, name, count: 0, bot };
          rec.count += 1;
          rec.name = name;
          rec.bot = bot;
          replyToBot.set(uid, rec);
        }
      }
      if (typeof e.c === 'string') {
        const m = ATTACH_RE.exec(e.c);
        let clean = e.c;
        if (m) {
          attachMsgs += 1;
          attachUnits += Number(m[1]) || 0;
          clean = e.c.replace(ATTACH_RE, '').trim();
        }
        lengths.push(clean.length);
        if (e.c.length >= 500) at500 += 1;
        const hearts = (clean.match(/❤/g) || []).length;
        if (hearts) {
          heartTotal += hearts;
          if (hearts > heartMaxOne) {
            heartMaxOne = hearts;
            heartMaxAuthor = name;
          }
        }
      }
    }
  }

  talkers.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  const chanList = [...channels.entries()]
    .map(([id, count]) => ({
      id,
      name: plainChannelName(channelNames.get(id), id),
      rawName: channelNames.get(id) || id,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));

  const newestMs = newest || now;
  const endDay = parisParts(newestMs).dateStr;
  const last7 = [];
  const end = new Date(`${endDay}T12:00:00+01:00`);
  // Walk 6 days back in Paris by subtracting 24h from noon to avoid DST edges.
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end.getTime() - i * 24 * 60 * 60 * 1000);
    const p = parisParts(d.getTime());
    const label = `${p.day} ${MONTHS_SHORT[p.month - 1]}`;
    last7.push({ date: p.dateStr, label, count: perDay.get(p.dateStr) || 0, ongoing: p.dateStr === endDay });
  }

  const peakHour = hours.reduce((best, n, h) => (n > hours[best] ? h : best), 0);

  lengths.sort((a, b) => a - b);
  const avgLen = lengths.length ? lengths.reduce((s, n) => s + n, 0) / lengths.length : 0;
  const medianLen = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;

  const selfChanList = [...selfChans.entries()]
    .map(([name, count]) => ({ name: plainChannelName(name, name), count }))
    .sort((a, b) => b.count - a.count);

  const replies = [...replyToBot.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  const repliesTotal = replies.reduce((s, r) => s + r.count, 0);

  const trigPath = triggersFile || path.join(root, 'triggers.json');
  const trigDoc = readJson(trigPath, { triggers: [] });
  const trigList = Array.isArray(trigDoc.triggers) ? trigDoc.triggers : [];
  const trigKinds = {};
  let trigOldest = null;
  let trigNewest = null;
  for (const t of trigList) {
    const k = t && t.trigger ? String(t.trigger) : 'autre';
    trigKinds[k] = (trigKinds[k] || 0) + 1;
    if (typeof t.at === 'number') {
      if (trigOldest === null || t.at < trigOldest) trigOldest = t.at;
      if (trigNewest === null || t.at > trigNewest) trigNewest = t.at;
    }
  }
  const triggerOrder = ['mention', 'name', 'follow', 'keyword', 'dm', 'reply_to_bot', 'slash_fiche', 'daily_roast'];
  const triggerList = [];
  const seenKind = new Set();
  for (const k of triggerOrder) {
    if (trigKinds[k]) {
      triggerList.push({ type: k === 'reply_to_bot' ? 'reply' : k, count: trigKinds[k] });
      seenKind.add(k);
    }
  }
  for (const [k, c] of Object.entries(trigKinds)) {
    if (!seenKind.has(k)) triggerList.push({ type: k, count: c });
  }

  const lifetimeDoc = lifetime && typeof lifetime === 'object' ? lifetime : null;

  return {
    generatedAt: now,
    generatedLabel: `${fmtParis(now)} Europe/Paris`,
    cap: KEEP_CAP,
    users: users.size,
    humanUsers,
    botUsers,
    messages: total,
    humanMsgs,
    botMsgs,
    oldest,
    newest,
    oldestLabel: oldest != null ? fmtParis(oldest) : null,
    newestLabel: newest != null ? fmtParis(newest) : null,
    spanDays: oldest != null && newest != null
      ? Math.max(0, Math.round((Date.parse(`${parisParts(newest).dateStr}T12:00:00+01:00`) - Date.parse(`${parisParts(oldest).dateStr}T12:00:00+01:00`)) / 86400000))
      : 0,
    notes: countNotes(uDir),
    memoryFiles: countMemory(path.join(root, 'memory')),
    talkers,
    topTalkers: talkers.slice(0, 10),
    channels: chanList,
    topChannels: chanList.slice(0, 10),
    channelCount: chanList.length,
    hours,
    dows,
    dowNames: DOW_NAMES,
    last7,
    last7Total: last7.reduce((s, d) => s + d.count, 0),
    peakHour,
    peakHourCount: hours[peakHour] || 0,
    self: {
      messages: selfEntries.length,
      channels: selfChanList,
      sinceLabel: selfEntries.length && selfEntries[0] && selfEntries[0].t ? fmtParis(selfEntries[0].t) : null,
    },
    repliesToBot: { total: repliesTotal, people: replies },
    length: {
      withContent: lengths.length,
      avg: avgLen,
      avgRounded: Math.round(avgLen),
      median: medianLen,
      atOrOver500: at500,
    },
    attachments: { messages: attachMsgs, units: attachUnits },
    hearts: { total: heartTotal, maxOne: heartMaxOne, author: heartMaxAuthor },
    triggers: {
      recorded: trigList.length,
      kinds: trigKinds,
      list: triggerList,
      oldest: trigOldest,
      newest: trigNewest,
      oldestLabel: trigOldest != null ? fmtParis(trigOldest) : null,
      newestLabel: trigNewest != null ? fmtParis(trigNewest) : null,
    },
    lifetime: lifetimeDoc,
    frNum,
    fmtParis,
  };
}

module.exports = {
  computeStats,
  defaultSelfId,
  usersDirFrom,
  frNum,
  fmtParis,
  parisParts,
  plainChannelName,
  KEEP_CAP,
  TZ,
};
