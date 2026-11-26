'use strict';

/**
 * Voice greetings when someone (human or bot) arrives in a voice channel:
 * a fresh join, or a move from another voice channel. If the bot is not
 * already in the destination, it joins to speak, then auto-voice may
 * move it back. Pre-written French lines + Google Translate TTS (no API
 * key). Failures are logged and swallowed: they must never crash the bridge.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_CONNECT_MS = 20_000;
const DEFAULT_TTS_MS = 8_000;
const DEFAULT_PLAY_MS = 30_000;
const DEFAULT_MAX_QUEUE = 6;
const AUDIO_RETRY_MS = 30 * 1000;
const TTS_MAX_CHARS = 180;
const TTS_TEST_PHRASE = 'Test audio. Un, deux, trois.';
const TTS_CACHE_MAX = 40;

const GREETINGS = [
  'Salut gros con de {name}.',
  'Salut {name}, gros connard.',
  'L\'enculé de {name}.',
  '{name}, sale fils de pute.',
  'Sac à merde de {name}.',
  'Salut {name}, trou de balle.',
  'Encore ce con de {name}.',
  'Voilà {name}, gros enfoiré.',
  '{name}, t\'es de la merde.',
  'Salut {name}, pauvre con.',
  'Oh putain, {name} le boloss.',
  '{name}, ce gros naze.',
  'Salut {name}, espèce de con.',
  '{name} débarque, sale merde.',
  'Eh {name}, tas de merde.',
  'Coucou {name}, sale con.',
  '{name}, ferme ta gueule.',
  'Trou du cul, {name}.',
  'Salut {name}, gros enculé.',
  'Putain, c\'est {name}.',
  '{name} est là, quel con.',
  'Bienvenue {name}, enculé.',
  '{name}, t\'es lourd, con.',
  'Revoilà {name}, fils de pute.',
  'Gros salaud de {name}.',
  '{name} se ramène, le naze.',
  'Putain, {name} le connard.',
  'Salut toi, {name} le con.',
  '{name}, va chier.',
  'Encore {name}, quel enculé.',
];

const TTS_ENDPOINTS = [
  (q) => `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=gtx&tl=fr&q=${q}`,
  (q) => `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=fr&q=${q}`,
];

function flagOn(value, fallback = 'on') {
  return !['0', 'false', 'no', 'off'].includes(String(value ?? fallback).trim().toLowerCase());
}

function cleanName(raw) {
  let s = String(raw || '');
  try { s = s.normalize('NFC'); } catch { /* ignore */ }
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, '');
  s = s.replace(/\p{M}{3,}/gu, '');
  s = s.replace(/[_./\\|@+]+/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s'’\-]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 32) s = s.slice(0, 32).trim();
  return s || 'toi';
}

function fillPhrase(template, name) {
  return String(template).split('{name}').join(name);
}

function pickPhrase(name, lastIndex) {
  if (!GREETINGS.length) return fillPhrase('Salut {name}.', name);
  let i = Math.floor(Math.random() * GREETINGS.length);
  if (GREETINGS.length > 1 && i === lastIndex) i = (i + 1) % GREETINGS.length;
  return { text: fillPhrase(GREETINGS[i], name), index: i };
}

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
];

function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const fromStatic = require('ffmpeg-static');
    if (fromStatic && fs.existsSync(fromStatic)) return fromStatic;
  } catch {
    /* optional */
  }
  return null;
}

function hasFfmpeg() {
  // Do not spawn `ffmpeg -version`: on the 256MB Fly machine that call
  // often hits a 4s spawnSync timeout (ETIMEDOUT) even when the binary
  // is present, and a cached false would skip every greeting.
  const bin = findFfmpeg();
  if (bin && process.env.FFMPEG_PATH !== bin) process.env.FFMPEG_PATH = bin;
  return Boolean(bin);
}

function transcodeToPcm(mp3Path, pcmPath, timeoutMs = 20_000) {
  const bin = findFfmpeg();
  if (!bin) return Promise.reject(new Error('ffmpeg not found'));
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-threads', '1', '-y',
      '-i', mp3Path,
      '-f', 's16le', '-ar', '48000', '-ac', '2',
      pcmPath,
    ];
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('ffmpeg transcode timeout'));
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 2000) err = err.slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0) {
          resolve(pcmPath);
          return;
        }
      } catch { /* fall through */ }
      reject(new Error(`ffmpeg transcode exit ${code}${err ? `: ${err.trim().slice(0, 180)}` : ''}`));
    });
  });
}


function cacheKey(text) {
  return crypto.createHash('sha1').update(`s16le-48k-2:${String(text)}`).digest('hex');
}

function defaultCacheDir() {
  if (process.env.TTS_CACHE_DIR) return process.env.TTS_CACHE_DIR;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, 'tts-cache');
  if (fs.existsSync('/app/data')) return path.join('/app/data', 'tts-cache');
  return path.join(os.tmpdir(), 'slayer-tts-cache');
}

function evictTtsCache(dir, maxEntries = TTS_CACHE_MAX) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pcm'));
    if (files.length <= maxEntries) return;
    const stats = files.map((f) => {
      const pth = path.join(dir, f);
      const st = fs.statSync(pth);
      return { pth, atime: st.atimeMs || st.mtimeMs };
    }).sort((a, b) => a.atime - b.atime);
    for (const item of stats.slice(0, files.length - maxEntries)) {
      try { fs.unlinkSync(item.pth); } catch { /* ignore */ }
      try { fs.unlinkSync(item.pth.replace(/\.pcm$/, '.mp3')); } catch { /* ignore */ }
    }
  } catch {
    /* ignore */
  }
}

async function ensureCachedPcm(text, { ttsFn = fetchTtsMp3, ttsMs = DEFAULT_TTS_MS, cacheDir } = {}) {
  const dir = cacheDir || defaultCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const key = cacheKey(String(text).slice(0, TTS_MAX_CHARS));
  const mp3Path = path.join(dir, `${key}.mp3`);
  const pcmPath = path.join(dir, `${key}.pcm`);
  if (fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0) {
    try { fs.utimesSync(pcmPath, new Date(), new Date()); } catch { /* ignore */ }
    return { pcmPath, mp3Path, cached: true, ttsMs: 0, transcodeMs: 0 };
  }
  const t0 = Date.now();
  if (!(fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 64)) {
    await ttsFn(text, mp3Path, ttsMs);
  }
  const ttsElapsed = Date.now() - t0;
  const t1 = Date.now();
  await transcodeToPcm(mp3Path, pcmPath);
  evictTtsCache(dir);
  return { pcmPath, mp3Path, cached: false, ttsMs: ttsElapsed, transcodeMs: Date.now() - t1 };
}

async function fetchTtsMp3(text, dest, timeoutMs = DEFAULT_TTS_MS) {
  const clipped = String(text).slice(0, TTS_MAX_CHARS);
  const q = encodeURIComponent(clipped);
  let lastErr = new Error('no tts endpoint');
  for (const makeUrl of TTS_ENDPOINTS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(makeUrl(q), {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; cum-slayer-bridge/voice-greet)',
          Accept: 'audio/mpeg,audio/*,*/*',
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        lastErr = new Error(`tts http ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64 || (buf[0] !== 0xff && buf.slice(0, 3).toString() !== 'ID3')) {
        lastErr = new Error('tts response is not mp3');
        continue;
      }
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function cooldownKey(userId, channelId) {
  return `${userId}:${channelId}`;
}

function shouldGreet(event) {
  const {
    botId, userId, oldChannelId, newChannelId, channelType, now,
    cooldownUntil, queueUserIds,
  } = event;
  if (!botId || !userId) return { ok: false, reason: 'missing-id' };
  if (userId === botId) return { ok: false, reason: 'self' };
  if (!newChannelId) return { ok: false, reason: 'left' };
  if (newChannelId === oldChannelId) return { ok: false, reason: 'no-channel-change' };
  if (channelType != null && channelType !== 2) return { ok: false, reason: 'not-voice' };
  // A channel change (fresh join or move) is an arrival. Grace only exists
  // so we do not greet people already in a room when the bot itself joins;
  // those people do not emit a channel change, so arrivals are never gated
  // on the bot already being in the destination, nor on the grace window.
  if (cooldownUntil && now < cooldownUntil) return { ok: false, reason: 'cooldown' };
  if (queueUserIds && queueUserIds.has(userId)) return { ok: false, reason: 'already-queued' };
  return { ok: true };
}

function createVoiceGreeter(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const enabled = opts.enabled !== undefined ? Boolean(opts.enabled) : true;
  const cooldownMs = Number(opts.cooldownMs || DEFAULT_COOLDOWN_MS);
  const graceMs = Number(opts.graceMs || DEFAULT_GRACE_MS);
  const connectMs = Number(opts.connectMs || DEFAULT_CONNECT_MS);
  const ttsMs = Number(opts.ttsMs || DEFAULT_TTS_MS);
  const playMs = Number(opts.playMs || DEFAULT_PLAY_MS);
  const maxQueue = Number(opts.maxQueue || DEFAULT_MAX_QUEUE);
  const sendVoiceStateUpdate = opts.sendVoiceStateUpdate || (() => {});
  const nowFn = opts.now || (() => Date.now());
  const ttsFn = opts.fetchTts || fetchTtsMp3;
  const playFn = opts.play; // optional inject for tests
  const tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'slayer-tts');
  const cacheDir = opts.cacheDir || defaultCacheDir();
  let lastPlayStats = null;

  const cooldownUntil = new Map(); // `${userId}:${channelId}` -> ts
  const lastPhrase = new Map();
  const joinedAt = new Map(); // guildId -> { channelId, at }
  const audioFailedUntil = new Map();
  const connecting = new Map(); // guildId -> Promise<boolean>
  const queue = [];
  const queuedUsers = new Set();
  let runPromise = null;
  let currentJob = null;
  let voiceLib = null;
  hasFfmpeg();

  function loadVoiceLib() {
    if (voiceLib) return voiceLib;
    voiceLib = require('@discordjs/voice');
    return voiceLib;
  }

  function markJoined(guildId, channelId) {
    if (!guildId || !channelId) return;
    const prev = joinedAt.get(guildId);
    // Re-asserting the same channel must not restart the 8s grace window:
    // auto-voice resync and join debounce were silently dropping arrivals.
    if (prev && prev.channelId === channelId) return false;
    joinedAt.set(guildId, { channelId, at: nowFn() });
    return true;
  }

  function botChannel(guild) {
    const botId = opts.getBotId ? opts.getBotId() : null;
    if (!guild || !botId) return null;
    return guild.voiceStates?.cache?.get(botId)?.channelId || joinedAt.get(guild.id)?.channelId || null;
  }

  function destroyConnection(guildId) {
    try {
      const { getVoiceConnection } = loadVoiceLib();
      const conn = getVoiceConnection(guildId);
      if (conn) conn.destroy();
    } catch {
      /* ignore */
    }
  }

  function sameChannel(connection, channelId) {
    const id = connection?.joinConfig?.channelId;
    return Boolean(id) && String(id) === String(channelId);
  }

  function leave(guildId) {
    if (!guildId) return;
    joinedAt.delete(guildId);
    destroyConnection(guildId);
  }

  function shutdown() {
    queue.length = 0;
    queuedUsers.clear();
    for (const guildId of [...joinedAt.keys()]) destroyConnection(guildId);
  }

  function hookConnection(connection, guildId) {
    const { VoiceConnectionStatus } = loadVoiceLib();
    const onErr = (err) => {
      log(`voice-greet warn: connection error guild=${guildId}: ${err?.message || err}`);
      try { connection.destroy(); } catch { /* ignore */ }
    };
    connection.on('error', onErr);
    connection.on('stateChange', (_old, next) => {
      if (next.status === VoiceConnectionStatus.Disconnected) {
        try { connection.destroy(); } catch { /* ignore */ }
      }
    });
  }

  async function ensureAudioInner(guild, channel, force = false) {
    if (!enabled || !guild || !channel) {
      if (guild) sendVoiceStateUpdate(guild, channel?.id ?? null);
      return false;
    }
    if (channel.type !== 2) {
      sendVoiceStateUpdate(guild, channel.id);
      return false;
    }
    markJoined(guild.id, channel.id);
    const until = audioFailedUntil.get(guild.id) || 0;
    if (!force && nowFn() < until) {
      sendVoiceStateUpdate(guild, channel.id);
      return false;
    }
    const {
      joinVoiceChannel, entersState, VoiceConnectionStatus, getVoiceConnection,
    } = loadVoiceLib();

    async function waitReady(connection, label) {
      if (connection.state.status === VoiceConnectionStatus.Ready) return connection;
      await entersState(connection, VoiceConnectionStatus.Ready, connectMs);
      log(`voice-greet audio ready guild=${guild.id} channel=${channel.id} via=${label}`);
      return connection;
    }

    let lastErr = new Error('audio join failed');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const existing = getVoiceConnection(guild.id);
        if (existing && sameChannel(existing, channel.id)) {
          const st = existing.state.status;
          if (st === VoiceConnectionStatus.Ready) return true;
          if (st === VoiceConnectionStatus.Signalling || st === VoiceConnectionStatus.Connecting) {
            await waitReady(existing, `wait-${attempt}`);
            return true;
          }
        }
        if (existing) {
          try { existing.destroy(); } catch { /* ignore */ }
        }
        const connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
          selfMute: false,
        });
        hookConnection(connection, guild.id);
        await waitReady(connection, `join-${attempt}`);
        audioFailedUntil.delete(guild.id);
        return true;
      } catch (err) {
        lastErr = err;
        log(`voice-greet warn: audio join attempt ${attempt}/3 failed guild=${guild.id}: ${err.message}`);
        destroyConnection(guild.id);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }
    log(`voice-greet warn: audio join failed guild=${guild.id}: ${lastErr.message}; falling back to presence-only`);
    audioFailedUntil.set(guild.id, nowFn() + AUDIO_RETRY_MS);
    destroyConnection(guild.id);
    try { sendVoiceStateUpdate(guild, channel.id); } catch (e) {
      log(`voice-greet warn: op4 fallback failed: ${e.message}`);
    }
    return false;
  }

  function ensureAudio(guild, channel, { force = false } = {}) {
    if (!guild) return Promise.resolve(false);
    const inflight = connecting.get(guild.id);
    if (inflight) {
      return inflight.then((ok) => {
        if (ok || !force) return ok;
        return ensureAudio(guild, channel, { force: true });
      });
    }
    const p = ensureAudioInner(guild, channel, force).finally(() => {
      if (connecting.get(guild.id) === p) connecting.delete(guild.id);
    });
    connecting.set(guild.id, p);
    return p;
  }

  async function playOnConnection(guildId, audioPath, { pcm = false, onPlaying } = {}) {
    if (typeof playFn === 'function') {
      const start = nowFn();
      const result = await playFn(guildId, audioPath);
      if (typeof onPlaying === 'function') onPlaying(Math.max(0, nowFn() - start));
      return result;
    }
    const {
      getVoiceConnection, createAudioPlayer, createAudioResource,
      AudioPlayerStatus, entersState, NoSubscriberBehavior, StreamType,
      VoiceConnectionStatus,
    } = loadVoiceLib();
    let connection = getVoiceConnection(guildId);
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
      const guild = opts.getGuild ? opts.getGuild(guildId) : null;
      const channelId = connection?.joinConfig?.channelId;
      const channel = guild && channelId ? guild.channels?.cache?.get(channelId) : null;
      if (guild && channel) {
        const ready = await ensureAudio(guild, channel, { force: true });
        if (!ready) throw new Error('audio not ready');
        connection = getVoiceConnection(guildId);
      }
    }
    if (!connection) throw new Error('no voice connection');
    const pcmPath = pcm ? audioPath : `${audioPath}.pcm`;
    const tempPcm = !pcm;
    try {
      if (!pcm) await transcodeToPcm(audioPath, pcmPath);
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      // 20 ms of s16le 48 kHz stereo. Small chunks keep opusscript from
      // blocking the event loop on a huge first read (256MB machine).
      const resource = createAudioResource(fs.createReadStream(pcmPath, { highWaterMark: 3840 }), {
        inputType: StreamType.Raw,
        silencePaddingFrames: 5,
      });
      const subscription = connection.subscribe(player);
      try {
        player.play(resource);
        await entersState(player, AudioPlayerStatus.Playing, 15_000);
        if (typeof onPlaying === 'function') onPlaying();
        await entersState(player, AudioPlayerStatus.Idle, playMs);
      } finally {
        try { player.stop(true); } catch { /* ignore */ }
        try { subscription?.unsubscribe(); } catch { /* ignore */ }
      }
    } finally {
      if (tempPcm) {
        try { fs.unlinkSync(pcmPath); } catch { /* ignore */ }
      }
    }
  }

  function runQueue() {
    if (runPromise) return runPromise;
    runPromise = (async () => {
      try {
        while (queue.length) {
          const job = queue.shift();
          currentJob = job;
          queuedUsers.delete(job.userId);
          const tmp = path.join(tmpDir, `greet-${job.userId}-${nowFn()}.mp3`);
          const tStart = nowFn();
          let startMs = null;
          try {
            fs.mkdirSync(tmpDir, { recursive: true });
            const guild = opts.getGuild ? opts.getGuild(job.guildId) : null;
            const channel = guild?.channels?.cache?.get(job.channelId);
            const readyP = (guild && channel)
              ? ensureAudio(guild, channel, { force: false })
              : Promise.resolve(true);
            // Injected play() (unit tests) still receives the mp3 path.
            const prepareP = typeof playFn === 'function'
              ? ttsFn(job.text, tmp, ttsMs).then(() => ({ path: tmp, pcm: false, cached: false, ttsMs: 0, transcodeMs: 0 }))
              : ensureCachedPcm(job.text, { ttsFn, ttsMs, cacheDir }).then((r) => ({ path: r.pcmPath, pcm: true, ...r }));
            const [ready, prepared] = await Promise.all([readyP, prepareP]);
            if (!ready) throw new Error('audio not ready');
            await playOnConnection(job.guildId, prepared.path, {
              pcm: prepared.pcm,
              onPlaying: () => {
                startMs = nowFn() - tStart;
                log(`voice-greet playing user=${job.userId} bot=${job.isBot ? 'yes' : 'no'} start_ms=${startMs} tts_ms=${prepared.ttsMs || 0} transcode_ms=${prepared.transcodeMs || 0} cached=${prepared.cached ? 'yes' : 'no'}`);
              },
            });
            if (startMs == null) startMs = nowFn() - tStart;
            const totalMs = nowFn() - tStart;
            cooldownUntil.set(cooldownKey(job.userId, job.channelId), nowFn() + cooldownMs);
            lastPlayStats = {
              userId: job.userId,
              start_ms: startMs,
              total_ms: totalMs,
              cached: Boolean(prepared.cached),
              tts_ms: prepared.ttsMs || 0,
              transcode_ms: prepared.transcodeMs || 0,
            };
            log(`voice-greet played user=${job.userId} bot=${job.isBot ? 'yes' : 'no'} start_ms=${startMs} total_ms=${totalMs} cached=${prepared.cached ? 'yes' : 'no'}`);
          } catch (err) {
            log(`voice-greet warn: play failed user=${job.userId}: ${err.message}`);
          } finally {
            if (currentJob === job) currentJob = null;
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          }
        }
      } finally {
        runPromise = null;
        if (queue.length) return runQueue();
        if (typeof opts.onQueueIdle === 'function') {
          try { opts.onQueueIdle(); } catch { /* ignore */ }
        }
      }
    })();
    return runPromise;
  }

  async function debugSpeak(text) {
    try {
      if (!findFfmpeg()) return { ok: false, reason: 'no-ffmpeg' };
      const ctx = opts.getSpeakContext ? opts.getSpeakContext() : null;
      if (!ctx?.guild || !ctx?.channel) return { ok: false, reason: 'bot-not-in-voice' };
      const ready = await ensureAudio(ctx.guild, ctx.channel, { force: true });
      if (!ready) return { ok: false, reason: 'audio-not-ready' };
      const phrase = String(text || TTS_TEST_PHRASE).slice(0, TTS_MAX_CHARS);
      queue.push({
        userId: 'debug-test',
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        text: phrase,
        isBot: false,
      });
      log(`voice-greet queued user=debug-test q=${queue.length}`);
      await runQueue();
      const stats = lastPlayStats && lastPlayStats.userId === 'debug-test' ? lastPlayStats : null;
      return { ok: true, ...(stats || {}) };
    } catch (err) {
      log(`voice-greet warn: debugSpeak: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }


  async function prewarm() {
    const t0 = Date.now();
    const bin = findFfmpeg();
    if (!bin) {
      log('voice-greet warn: prewarm skipped, no ffmpeg');
      return { ok: false, reason: 'no-ffmpeg' };
    }
    await new Promise((resolve) => {
      const child = spawn(bin, [
        '-hide_banner', '-loglevel', 'error', '-threads', '1',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.05',
        '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume();
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 15_000);
      const done = () => { clearTimeout(timer); resolve(); };
      child.on('close', done);
      child.on('error', done);
    });
    const ffmpegMs = Date.now() - t0;
    try {
      const r = await ensureCachedPcm(TTS_TEST_PHRASE, { ttsFn, ttsMs, cacheDir });
      log(`voice-greet prewarm ready ffmpeg_ms=${ffmpegMs} tts_ms=${r.ttsMs} transcode_ms=${r.transcodeMs} cached=${r.cached ? 'yes' : 'no'}`);
      return { ok: true, ffmpeg_ms: ffmpegMs, tts_ms: r.ttsMs, transcode_ms: r.transcodeMs, cached: r.cached };
    } catch (err) {
      log(`voice-greet warn: prewarm: ${err.message} ffmpeg_ms=${ffmpegMs}`);
      return { ok: false, reason: 'error', ffmpeg_ms: ffmpegMs };
    }
  }

  function handleVoiceStateUpdate(oldState, newState) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    try {
      const guild = newState?.guild || oldState?.guild;
      if (!guild) return { ok: false, reason: 'no-guild' };
      const botId = opts.getBotId ? opts.getBotId() : null;
      const userId = newState?.id || oldState?.id;
      const newChannelId = newState?.channelId || null;
      const oldChannelId = oldState?.channelId || null;
      const botChannelId = botChannel(guild);
      const channel = newChannelId ? guild.channels?.cache?.get(newChannelId) : null;
      const join = joinedAt.get(guild.id);
      const now = nowFn();
      const decision = shouldGreet({
        botId,
        botChannelId,
        userId,
        oldChannelId,
        newChannelId,
        channelType: channel?.type,
        now,
        joinedAt: join && join.channelId === botChannelId ? join.at : 0,
        graceMs,
        cooldownUntil: newChannelId ? (cooldownUntil.get(cooldownKey(userId, newChannelId)) || 0) : 0,
        queueUserIds: queuedUsers,
      });
      const channelChanged = oldChannelId !== newChannelId;
      const relevant = oldChannelId === botChannelId || newChannelId === botChannelId || channelChanged;
      if (!decision.ok) {
        if (decision.reason === 'already-queued' && newChannelId) {
          const job = queue.find((j) => j.userId === userId && j.guildId === guild.id);
          if (job && job.channelId !== newChannelId) {
            const prevChan = job.channelId;
            job.channelId = newChannelId;
            log(`voice-greet retarget user=${userId} old=${oldChannelId || 'none'} from=${prevChan} new=${newChannelId}`);
            return { ok: true, retargeted: true };
          }
        }
        if (relevant) {
          log(`voice-greet skip user=${userId} old=${oldChannelId || 'none'} new=${newChannelId || 'none'} botchan=${botChannelId || 'none'} reason=${decision.reason}`);
        }
        return decision;
      }
      if (!hasFfmpeg()) {
        log(`voice-greet skip user=${userId} old=${oldChannelId || 'none'} new=${newChannelId || 'none'} reason=no-ffmpeg`);
        return { ok: false, reason: 'no-ffmpeg' };
      }
      const member = newState?.member || oldState?.member || guild.members?.cache?.get(userId);
      const user = member?.user || newState?.member?.user;
      const rawName = member?.displayName || user?.globalName || user?.username || 'toi';
      const name = cleanName(rawName);
      const picked = pickPhrase(name, lastPhrase.get(userId));
      lastPhrase.set(userId, picked.index);
      if (queue.length >= maxQueue) {
        log(`voice-greet skip user=${userId} old=${oldChannelId || 'none'} new=${newChannelId || 'none'} reason=queue-full`);
        return { ok: false, reason: 'queue-full' };
      }
      // Cooldown is armed only after a successful play, not when we merely queue.
      queuedUsers.add(userId);
      queue.push({
        userId,
        guildId: guild.id,
        channelId: newChannelId,
        text: picked.text,
        isBot: Boolean(user?.bot || member?.user?.bot),
      });
      const follow = botChannelId && botChannelId !== newChannelId ? 'yes' : 'no';
      log(`voice-greet queued user=${userId} bot=${user?.bot ? 'yes' : 'no'} q=${queue.length} old=${oldChannelId || 'none'} new=${newChannelId || 'none'} botchan=${botChannelId || 'none'} from_move=${oldChannelId && oldChannelId !== newChannelId ? 'yes' : 'no'} follow=${follow}`);
      setTimeout(() => { runQueue().catch((err) => log(`voice-greet warn: queue: ${err.message}`)); }, 0).unref?.();
      return { ok: true, text: picked.text, name };
    } catch (err) {
      log(`voice-greet warn: handle failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
  }

  function heldChannel(guildId) {
    if (!guildId) return null;
    if (currentJob && currentJob.guildId === guildId) return currentJob.channelId;
    const queued = queue.find((j) => j.guildId === guildId);
    return queued ? queued.channelId : null;
  }

  return {
    enabled,
    cooldownMs,
    graceMs,
    markJoined,
    leave,
    shutdown,
    ensureAudio,
    handleVoiceStateUpdate,
    debugSpeak,
    prewarm,
    heldChannel,
    // test helpers
    _queue: queue,
    _cooldownUntil: cooldownUntil,
    _runQueue: runQueue,
  };
}

module.exports = {
  GREETINGS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_GRACE_MS,
  cleanName,
  fillPhrase,
  pickPhrase,
  shouldGreet,
  cooldownKey,
  fetchTtsMp3,
  hasFfmpeg,
  findFfmpeg,
  transcodeToPcm,
  ensureCachedPcm,
  TTS_TEST_PHRASE,
  flagOn,
  createVoiceGreeter,
};
