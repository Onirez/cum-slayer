'use strict';

/**
 * Read-only full-history message count for a guild.
 * Uses the bot token from the environment only — never prints or writes it.
 * Counts message metadata (id, timestamp, author id/flags/name). Never stores
 * message content and never writes usermem.
 *
 *   node full_count.js [--out PATH] [--guild ID] [--fresh] [--resume]
 */

const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';
const DEFAULT_GUILD = '1095123126746099834';
const PAGE = 100;
const PACE_MS = Math.max(50, Number(process.env.FULL_COUNT_PACE_MS || 400) || 400);
const MAX_ATTEMPTS = 8;

const TYPE_LABELS = {
  0: 'texte',
  2: 'salon vocal (chat)',
  5: 'annonces',
  10: 'fil d’annonce',
  11: 'fil public',
  12: 'fil privé',
  13: 'conférence (chat)',
  15: 'forum',
  16: 'média',
};

const TEXT_TYPES = new Set([0, 2, 5, 10, 11, 12, 13]);
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
const FORUM_TYPES = new Set([15, 16]);

function dataDir() {
  try {
    const c = require('./config');
    if (c && c.DATA_DIR) return c.DATA_DIR;
  } catch { /* live tree */ }
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.env.FULL_COUNT_FILE) return path.dirname(process.env.FULL_COUNT_FILE);
  if (fs.existsSync(path.join(__dirname, 'bridge.js'))) return path.join(__dirname, 'data');
  return path.join(__dirname, '..', 'data');
}

function defaultOutFile() {
  return process.env.FULL_COUNT_FILE || path.join(dataDir(), 'full_count.json');
}

function redact(value, token) {
  let s = String(value ?? '');
  const tok = token || process.env.DISCORD_BOT_TOKEN || '';
  if (tok && s.includes(tok)) s = s.split(tok).join('[token]');
  s = s.replace(/Bot\s+[A-Za-z0-9._-]{20,}/g, 'Bot [token]');
  return s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function typeLabel(type) {
  return TYPE_LABELS[type] || `type ${type}`;
}

function authorName(author) {
  if (!author || typeof author !== 'object') return 'inconnu';
  const n = author.global_name || author.globalName || author.username || author.id;
  return String(n || 'inconnu').slice(0, 80);
}

const monthFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
});
const parisFmtCache = new Map();
function parisFormatter(withTime) {
  const key = withTime ? 'time' : 'date';
  if (!parisFmtCache.has(key)) {
    parisFmtCache.set(key, new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: withTime ? '2-digit' : undefined,
      minute: withTime ? '2-digit' : undefined,
      hourCycle: 'h23',
    }));
  }
  return parisFmtCache.get(key);
}

function monthKey(ts) {
  const parts = monthFmt.formatToParts(new Date(ts));
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}

function fmtParis(ms, withTime = true) {
  const parts = parisFormatter(withTime).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const date = `${get('day')} ${get('month')} ${get('year')}`;
  if (!withTime) return date;
  return `${date} ${get('hour')}:${get('minute')}`;
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}


function availableMemKb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = txt.match(/MemAvailable:\s+(\d+)/);
    return m ? Number(m[1]) : Infinity;
  } catch {
    return Infinity;
  }
}

async function maybePauseForMemory(doSleep, log) {
  const kb = availableMemKb();
  if (kb < 32 * 1024) {
    log('full_count pausing, low memory');
    await doSleep(8000);
  }
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    const prev = Number(String(fs.readFileSync(lockFile, 'utf8')).trim());
    if (prev) {
      try {
        process.kill(prev, 0);
        throw new Error(`full_count already running pid=${prev}`);
      } catch (err) {
        if (err.code !== 'ESRCH' && !String(err.message || '').includes('already running')) throw err;
        if (String(err.message || '').includes('already running')) throw err;
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid));
  return () => { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } };
}

function createScanner(opts = {}) {
  const token = opts.token !== undefined ? opts.token : process.env.DISCORD_BOT_TOKEN;
  const doFetch = opts.fetch || fetch;
  const doSleep = opts.sleep || sleep;
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((msg) => console.log(msg));
  const paceMs = opts.paceMs != null ? opts.paceMs : PACE_MS;
  let nextOkAt = 0;

  async function api(pathname) {
    if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
    let lastErr = 'request failed';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = nextOkAt - now();
      if (wait > 0) await doSleep(wait);
      if (paceMs) await doSleep(paceMs);
      let res;
      try {
        res = await doFetch(`${API}${pathname}`, {
          method: 'GET',
          headers: { Authorization: `Bot ${token}` },
        });
      } catch (err) {
        lastErr = redact(err && err.message ? err.message : err, token);
        await doSleep(500 * (attempt + 1));
        continue;
      }
      const remaining = Number(res.headers && res.headers.get && res.headers.get('X-RateLimit-Remaining'));
      const resetAfter = Number(res.headers && res.headers.get && res.headers.get('X-RateLimit-Reset-After'));
      if (remaining === 0 && Number.isFinite(resetAfter)) {
        nextOkAt = now() + Math.ceil(resetAfter * 1000) + 50;
      }
      if (res.status === 429) {
        let retry = 1000;
        try {
          const body = await res.json();
          retry = Math.ceil((Number(body.retry_after) || Number(res.headers.get('Retry-After')) || 1) * 1000);
        } catch {
          retry = Math.ceil((Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 1) * 1000);
        }
        log(`full_count rate-limited, waiting ${retry}ms`);
        await doSleep(retry + 100);
        continue;
      }
      if (res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await doSleep(400 * (attempt + 1));
        continue;
      }
      let data = null;
      const text = await res.text();
      if (text) {
        try { data = JSON.parse(text); } catch { data = null; }
      }
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
    }
    return { ok: false, status: 0, data: null, error: lastErr };
  }

  return { api, token, log, now };
}

function emptyTotals() {
  return {
    authors: new Map(),
    months: new Map(),
    humans: 0,
    bots: 0,
    oldest: null,
    newest: null,
    total: 0,
  };
}

function addMessage(totals, msg) {
  if (!msg || !msg.id) return;
  totals.total += 1;
  const ts = msg.timestamp ? Date.parse(msg.timestamp) : (msg.t || null);
  if (Number.isFinite(ts)) {
    if (totals.oldest == null || ts < totals.oldest) totals.oldest = ts;
    if (totals.newest == null || ts > totals.newest) totals.newest = ts;
    const mk = monthKey(ts);
    totals.months.set(mk, (totals.months.get(mk) || 0) + 1);
  }
  const author = msg.author || {};
  const id = String(author.id || msg.webhook_id || 'unknown');
  const bot = Boolean(author.bot) || Boolean(msg.webhook_id);
  if (bot) totals.bots += 1;
  else totals.humans += 1;
  const prev = totals.authors.get(id) || { id, name: authorName(author), bot, count: 0 };
  prev.count += 1;
  prev.bot = bot;
  if (author.id) prev.name = authorName(author);
  totals.authors.set(id, prev);
}

async function pageMessages(api, channelId, onPage, startBefore = null, afterPage = null) {
  let before = startBefore;
  let pages = 0;
  for (;;) {
    const q = `?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await api(`/channels/${channelId}/messages${q}`);
    if (res.status === 403) return { ok: false, noAccess: true, status: 403, pages };
    if (res.status === 404) return { ok: false, missing: true, status: 404, pages };
    if (!res.ok) return { ok: false, status: res.status, error: res.error || `HTTP ${res.status}`, pages };
    const list = Array.isArray(res.data) ? res.data : [];
    pages += 1;
    if (typeof onPage === 'function') onPage(list);
    if (typeof afterPage === 'function') await afterPage(pages, list);
    if (list.length < PAGE) return { ok: true, pages, exhausted: true };
    before = list[list.length - 1].id;
  }
}

async function listArchived(api, channelId, kind) {
  const out = [];
  let before = null;
  let noAccess = false;
  for (;;) {
    const q = new URLSearchParams({ limit: '100' });
    if (before) q.set('before', before);
    const pathName = kind === 'joined-private'
      ? `/channels/${channelId}/users/@me/threads/archived/private?${q}`
      : `/channels/${channelId}/threads/archived/${kind}?${q}`;
    const res = await api(pathName);
    if (res.status === 403) { noAccess = true; break; }
    if (res.status === 404) break;
    if (!res.ok) break;
    const threads = (res.data && res.data.threads) || [];
    out.push(...threads);
    if (!res.data.has_more || !threads.length) break;
    const last = threads[threads.length - 1];
    before = (last.thread_metadata && last.thread_metadata.archive_timestamp) || last.id;
  }
  return { threads: out, noAccess };
}

async function discoverTargets(api, guildId, log) {
  const ch = await api(`/guilds/${guildId}/channels`);
  if (!ch.ok) {
    throw new Error(`cannot list channels (HTTP ${ch.status}${ch.error ? `: ${redact(ch.error)}` : ''})`);
  }
  const channels = Array.isArray(ch.data) ? ch.data : [];
  const byId = new Map();
  for (const c of channels) if (c && c.id) byId.set(c.id, c);

  const threadParents = channels.filter((c) => THREAD_PARENT_TYPES.has(c.type));
  const threads = new Map();

  const active = await api(`/guilds/${guildId}/threads/active`);
  if (active.ok && active.data && Array.isArray(active.data.threads)) {
    for (const t of active.data.threads) if (t && t.id) threads.set(t.id, t);
  } else if (active.status === 403) {
    log('full_count cannot list active threads (403)');
  }

  const archivedPrivateDenied = [];
  for (const parent of threadParents) {
    for (const kind of ['public', 'private', 'joined-private']) {
      const listed = await listArchived(api, parent.id, kind === 'joined-private' ? 'joined-private' : kind);
      if (listed.noAccess && kind === 'private') {
        archivedPrivateDenied.push({ id: parent.id, name: parent.name, type: parent.type });
      }
      for (const t of listed.threads) if (t && t.id) threads.set(t.id, t);
    }
  }

  const targets = [];
  for (const c of channels) {
    if (!c || !c.id) continue;
    if (FORUM_TYPES.has(c.type)) {
      targets.push({
        id: c.id,
        name: c.name || c.id,
        type: c.type,
        skipMessages: true,
        reason: 'forum-parent',
      });
      continue;
    }
    if (TEXT_TYPES.has(c.type)) {
      targets.push({ id: c.id, name: c.name || c.id, type: c.type });
    }
  }
  for (const t of threads.values()) {
    if (targets.some((x) => x.id === t.id)) continue;
    targets.push({
      id: t.id,
      name: t.name || t.id,
      type: t.type,
      parentId: t.parent_id || null,
      thread: true,
    });
  }
  return { channels, targets, archivedPrivateDenied, threadCount: threads.size };
}

function summarize(totals, channels, meta) {
  const authors = [...totals.authors.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  const months = [...totals.months.entries()]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const years = {};
  for (const { month, count } of months) {
    const y = month.slice(0, 4);
    years[y] = (years[y] || 0) + count;
  }
  const yearList = Object.entries(years).map(([year, count]) => ({ year, count })).sort((a, b) => b.count - a.count);
  const monthPeak = months.reduce((best, m) => (!best || m.count > best.count ? m : best), null);
  const noAccess = channels.filter((c) => c.noAccess).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    typeLabel: typeLabel(c.type),
  }));
  return {
    guildId: meta.guildId,
    guildName: meta.guildName || null,
    scannedAt: meta.scannedAt,
    scannedAtLabel: `${fmtParis(meta.scannedAt)} Europe/Paris`,
    startedAt: meta.startedAt,
    durationMs: meta.scannedAt - meta.startedAt,
    total: totals.total,
    humans: totals.humans,
    bots: totals.bots,
    humanAuthors: authors.filter((a) => !a.bot).length,
    botAuthors: authors.filter((a) => a.bot).length,
    oldest: totals.oldest,
    oldestLabel: totals.oldest != null ? `${fmtParis(totals.oldest)} Europe/Paris` : null,
    newest: totals.newest,
    newestLabel: totals.newest != null ? `${fmtParis(totals.newest)} Europe/Paris` : null,
    busiestYear: yearList[0] || null,
    busiestMonth: monthPeak,
    channels: channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      typeLabel: typeLabel(c.type),
      thread: Boolean(c.thread),
      parentId: c.parentId || null,
      count: c.count || 0,
      oldest: c.oldest || null,
      oldestLabel: c.oldest ? `${fmtParis(c.oldest)} Europe/Paris` : null,
      noAccess: Boolean(c.noAccess),
      error: c.error || null,
    })),
    noAccess,
    authors,
    months,
    years,
    notes: {
      deletedChannels: 'Les salons ou fils déjà supprimés sont irrécupérables : Discord ne les expose plus, leurs messages ne peuvent pas être comptés.',
      scope: 'Tous les salons texte accessibles au bot (texte, annonces, chat des salons vocaux et des conférences, forums via leurs fils, fils actifs et archives publiques, plus les fils privés archivés visibles). Compte uniquement, aucun contenu conservé.',
      resume: Boolean(meta.resumed),
      archivedPrivateDenied: meta.archivedPrivateDenied || [],
    },
  };
}

function publicProgress(state) {
  return {
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    guildId: state.guildId,
    channelsDone: state.channelsDone,
    channelsTotal: state.channelsTotal,
    messages: state.messages,
    humans: state.humans,
    bots: state.bots,
    current: state.current || null,
    error: state.error || null,
  };
}

async function runAndSave(opts = {}) {
  const guildId = String(opts.guildId || process.env.FULL_COUNT_GUILD || process.env.GUILD_ID || DEFAULT_GUILD);
  const outFile = opts.outFile || defaultOutFile();
  const progressFile = opts.progressFile || outFile.replace(/\.json$/, '') + '.progress.json';
  const stateFile = opts.stateFile || outFile.replace(/\.json$/, '') + '.state.json';
  const fresh = Boolean(opts.fresh);
  const lockFile = opts.lockFile || outFile.replace(/\.json$/, '') + '.lock';
  const releaseLock = acquireLock(lockFile);
  const scanner = opts.scanner || createScanner(opts);
  const { api, log, now } = scanner;
  const doSleep = (scanner.sleep) || (opts.sleep) || sleep;
  const startedAt = now();
  try {

  let guildName = null;
  const g = await api(`/guilds/${guildId}`);
  if (g.ok && g.data) guildName = g.data.name || null;

  log(`full_count start guild=${guildId}${guildName ? ` name=${guildName}` : ''} fresh=${fresh}`);
  const discovered = await discoverTargets(api, guildId, log);
  log(`full_count discovered channels=${discovered.channels.length} targets=${discovered.targets.length} threads=${discovered.threadCount}`);

  const totals = emptyTotals();
  const results = [];
  const completed = new Set();
  let resumed = false;
  let currentInProgress = null;
  let resumePartial = null;

  if (!fresh && fs.existsSync(stateFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (prev && prev.guildId === guildId && prev.totals && prev.results) {
        totals.humans = prev.totals.humans || 0;
        totals.bots = prev.totals.bots || 0;
        totals.total = prev.totals.total || 0;
        totals.oldest = prev.totals.oldest || null;
        totals.newest = prev.totals.newest || null;
        for (const [k, v] of Object.entries(prev.totals.months || {})) totals.months.set(k, v);
        for (const a of prev.totals.authors || []) totals.authors.set(a.id, { ...a });
        for (const r of prev.results) {
          results.push(r);
          completed.add(r.id);
        }
        if (prev.inProgress && prev.inProgress.id && !completed.has(prev.inProgress.id)) {
          resumePartial = prev.inProgress;
        }
        resumed = results.length > 0 || Boolean(resumePartial);
        log(`full_count resume messages=${totals.total} channelsDone=${results.length} partial=${resumePartial ? resumePartial.id : 'no'}`);
      }
    } catch {
      log('full_count could not resume, starting fresh');
    }
  }

  const writeProgress = (extra = {}) => {
    const doc = publicProgress({
      status: extra.status || 'running',
      startedAt,
      updatedAt: now(),
      guildId,
      channelsDone: results.length,
      channelsTotal: discovered.targets.length,
      messages: totals.total,
      humans: totals.humans,
      bots: totals.bots,
      current: extra.current || null,
      error: extra.error || null,
    });
    try { atomicWrite(progressFile, doc); } catch { /* ignore */ }
    return doc;
  };
  const writeState = () => {
    try {
      atomicWrite(stateFile, {
        guildId,
        startedAt,
        updatedAt: now(),
        results,
        inProgress: currentInProgress,
        totals: {
          total: totals.total,
          humans: totals.humans,
          bots: totals.bots,
          oldest: totals.oldest,
          newest: totals.newest,
          months: Object.fromEntries(totals.months),
          authors: [...totals.authors.values()],
        },
      });
    } catch { /* ignore */ }
  };

  writeProgress({ status: 'running' });

  let index = 0;
  for (const target of discovered.targets) {
    index += 1;
    if (completed.has(target.id)) continue;
    const label = String(target.name || target.id);
    writeProgress({ current: `#${label} (${index}/${discovered.targets.length})` });
    const rec = {
      id: target.id,
      name: target.name,
      type: target.type,
      thread: Boolean(target.thread),
      parentId: target.parentId || null,
      count: 0,
      oldest: null,
      newest: null,
      noAccess: false,
      error: null,
      skipMessages: Boolean(target.skipMessages),
    };
    let startBefore = null;
    if (resumePartial && resumePartial.id === target.id) {
      rec.count = Number(resumePartial.count) || 0;
      rec.oldest = resumePartial.oldest || null;
      rec.newest = resumePartial.newest || null;
      startBefore = resumePartial.before || null;
      log(`full_count continue channel count=${rec.count} before=${startBefore || 'start'}`);
      resumePartial = null;
    }
    currentInProgress = { id: rec.id, name: rec.name, type: rec.type, count: rec.count, oldest: rec.oldest, newest: rec.newest, before: startBefore };
    if (target.skipMessages) {
      rec.error = target.reason || 'skipped';
      currentInProgress = null;
      results.push(rec);
      writeState();
      continue;
    }
    let pages = 0;
    const counted = await pageMessages(api, target.id, (list) => {
      for (const msg of list) {
        addMessage(totals, msg);
        rec.count += 1;
        const ts = msg.timestamp ? Date.parse(msg.timestamp) : null;
        if (Number.isFinite(ts)) {
          if (rec.oldest == null || ts < rec.oldest) rec.oldest = ts;
          if (rec.newest == null || ts > rec.newest) rec.newest = ts;
        }
      }
      if (list.length) currentInProgress = { id: rec.id, name: rec.name, type: rec.type, count: rec.count, oldest: rec.oldest, newest: rec.newest, before: list[list.length - 1].id };
      pages += 1;
      if (pages % 20 === 0) {
        log(`full_count channel pages=${pages} channel_total=${rec.count} grand_total=${totals.total}`);
        writeProgress({ current: `#${label} (${index}/${discovered.targets.length}) +${rec.count}` });
        writeState();
      }
    }, startBefore, async () => {
      await maybePauseForMemory(doSleep, log);
    });
    if (counted.noAccess) rec.noAccess = true;
    else if (!counted.ok) rec.error = counted.missing ? 'missing' : `HTTP ${counted.status}`;
    results.push(rec);
    completed.add(rec.id);
    currentInProgress = null;
    log(`full_count ${rec.noAccess ? 'no-access' : 'ok'} type=${target.type} count=${rec.count} total=${totals.total} (${index}/${discovered.targets.length})`);
    writeState();
  }

  const finishedAt = now();
  const summary = summarize(totals, results, {
    guildId,
    guildName,
    scannedAt: finishedAt,
    startedAt,
    resumed,
    archivedPrivateDenied: discovered.archivedPrivateDenied,
  });
  atomicWrite(outFile, summary);
  writeProgress({ status: 'done', current: null });
  try { fs.unlinkSync(stateFile); } catch { /* keep if unlink fails */ }
  log(`full_count done total=${summary.total} humans=${summary.humans} bots=${summary.bots} channels=${summary.channels.length} noAccess=${summary.noAccess.length} ms=${summary.durationMs} out=${path.basename(outFile)}`);
  return summary;
  } finally {
    releaseLock();
  }
}

function parseArgs(argv) {
  const args = argv.slice();
  const opts = { fresh: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fresh') opts.fresh = true;
    else if (args[i] === '--resume') opts.fresh = false;
    else if (args[i] === '--out') opts.outFile = args[++i];
    else if (args[i] === '--guild') opts.guildId = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const summary = await runAndSave(opts);
    console.log(JSON.stringify({
      ok: true,
      total: summary.total,
      humans: summary.humans,
      bots: summary.bots,
      channels: summary.channels.length,
      noAccess: summary.noAccess.length,
      oldestLabel: summary.oldestLabel,
      durationMs: summary.durationMs,
    }));
  } catch (err) {
    console.error(`full_count failed: ${redact(err && err.message ? err.message : err)}`);
    process.exit(1);
  }
}

module.exports = {
  API,
  DEFAULT_GUILD,
  TYPE_LABELS,
  TEXT_TYPES,
  THREAD_PARENT_TYPES,
  FORUM_TYPES,
  typeLabel,
  authorName,
  monthKey,
  fmtParis,
  redact,
  addMessage,
  emptyTotals,
  pageMessages,
  listArchived,
  discoverTargets,
  summarize,
  createScanner,
  runAndSave,
  parseArgs,
  defaultOutFile,
  dataDir,
};

if (require.main === module) {
  main();
}
