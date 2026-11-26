'use strict';

/**
 * Voice greetings when someone (human or bot) joins the channel the bot
 * is already in. Pre-written French lines + Google Translate TTS (no API
 * key). Failures are logged and swallowed: they must never crash the bridge.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_GRACE_MS = 8_000;
const DEFAULT_CONNECT_MS = 20_000;
const DEFAULT_TTS_MS = 8_000;
const DEFAULT_PLAY_MS = 30_000;
const DEFAULT_MAX_QUEUE = 6;
const AUDIO_RETRY_MS = 30 * 1000;
const TTS_MAX_CHARS = 180;

const GREETINGS = [
  'Salut gros con de {name}.',
  'Ah, {name} débarque. Encore un.',
  'Regardez-moi ça, {name} qui se pointe.',
  '{name} ! T\'étais pas trop tôt, félicitations.',
  'Salut {name}, je t\'attendais pas, ça tombe bien.',
  'Eh {name}, tu rentres comme chez toi, c\'est mignon.',
  'Voilà {name}. Essayez de pas tout casser.',
  '{name} est là. Cachez les trucs un peu bien.',
  'Salut {name}, gros boloss. Installe-toi.',
  'Oh putain, {name}. On est sauvés.',
  '{name} rejoint le vocal. Quel événement.',
  'Bienvenue {name}, sale merde. C\'est un plaisir, vraiment.',
  '{name}, tu pues déjà l\'ambiance depuis le seuil.',
  'Coucou {name}, tu vas encore tout pourrir, j\'en suis sûr.',
  'Salut {name}, t\'as le droit de parler, malheureusement.',
  '{name} est dans la place. Essayez de faire semblant d\'être contents.',
  'Ah merde, {name}. Bon, tant pis.',
  '{name} arrive. Je baisse déjà mes attentes.',
  'Salut toi, {name}. Fais un effort, pour une fois.',
  '{name} ! Le vocal venait à peine de devenir supportable.',
  'Eh bien voilà {name}. On clame pas victoire.',
  '{name} se ramène. Bravo champion.',
  'Salut {name}, t\'as pas raté grand-chose, surtout toi.',
  '{name} débarque comme une tornade de naze.',
  'Tiens, {name}. Je m\'en serais passé, mais bon.',
  '{name} est connecté. Que le spectacle médiocre commence.',
  'Salut {name}, reste pas planté là comme un con.',
  '{name}, t\'es là. On a trop de chance.',
  'Encore {name}. Ça devait arriver.',
  'Gros salaud de {name}, salut. C\'est tout ce que tu mérites.',
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
      '-hide_banner', '-loglevel', 'error', '-y',
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

function shouldGreet(event) {
  const {
    botId, botChannelId, userId, oldChannelId, newChannelId, channelType, now,
    joinedAt, graceMs, cooldownUntil, queueUserIds,
  } = event;
  if (!botId || !userId) return { ok: false, reason: 'missing-id' };
  if (userId === botId) return { ok: false, reason: 'self' };
  if (!botChannelId) return { ok: false, reason: 'bot-not-in-voice' };
  if (!newChannelId) return { ok: false, reason: 'left' };
  if (newChannelId === oldChannelId) return { ok: false, reason: 'no-channel-change' };
  if (newChannelId !== botChannelId) return { ok: false, reason: 'other-channel' };
  if (channelType != null && channelType !== 2) return { ok: false, reason: 'not-voice' };
  if (joinedAt && now - joinedAt < graceMs) return { ok: false, reason: 'grace' };
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

  const cooldownUntil = new Map(); // userId -> ts
  const lastPhrase = new Map();
  const joinedAt = new Map(); // guildId -> { channelId, at }
  const audioFailedUntil = new Map();
  const connecting = new Map(); // guildId -> Promise<boolean>
  const queue = [];
  const queuedUsers = new Set();
  let runPromise = null;
  let voiceLib = null;
  hasFfmpeg();

  function loadVoiceLib() {
    if (voiceLib) return voiceLib;
    voiceLib = require('@discordjs/voice');
    return voiceLib;
  }

  function markJoined(guildId, channelId) {
    if (!guildId || !channelId) return;
    joinedAt.set(guildId, { channelId, at: nowFn() });
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

  async function playOnConnection(guildId, mp3Path) {
    if (typeof playFn === 'function') {
      return playFn(guildId, mp3Path);
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
    const pcmPath = `${mp3Path}.pcm`;
    try {
      await transcodeToPcm(mp3Path, pcmPath);
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      const resource = createAudioResource(fs.createReadStream(pcmPath), {
        inputType: StreamType.Raw,
        silencePaddingFrames: 5,
      });
      const subscription = connection.subscribe(player);
      try {
        player.play(resource);
        await entersState(player, AudioPlayerStatus.Playing, 15_000);
        await entersState(player, AudioPlayerStatus.Idle, playMs);
      } finally {
        try { player.stop(true); } catch { /* ignore */ }
        try { subscription?.unsubscribe(); } catch { /* ignore */ }
      }
    } finally {
      try { fs.unlinkSync(pcmPath); } catch { /* ignore */ }
    }
  }

  function runQueue() {
    if (runPromise) return runPromise;
    runPromise = (async () => {
      try {
        while (queue.length) {
          const job = queue.shift();
          queuedUsers.delete(job.userId);
          const tmp = path.join(tmpDir, `greet-${job.userId}-${nowFn()}.mp3`);
          try {
            fs.mkdirSync(tmpDir, { recursive: true });
            const guild = opts.getGuild ? opts.getGuild(job.guildId) : null;
            const channel = guild?.channels?.cache?.get(job.channelId);
            if (guild && channel) {
              const ready = await ensureAudio(guild, channel, { force: true });
              if (!ready) throw new Error('audio not ready');
            }
            await ttsFn(job.text, tmp, ttsMs);
            await playOnConnection(job.guildId, tmp);
            log(`voice-greet played user=${job.userId} bot=${job.isBot ? 'yes' : 'no'}`);
          } catch (err) {
            log(`voice-greet warn: play failed user=${job.userId}: ${err.message}`);
          } finally {
            try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          }
        }
      } finally {
        runPromise = null;
        if (queue.length) return runQueue();
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
      const phrase = String(text || 'Test audio. Un, deux, trois.').slice(0, TTS_MAX_CHARS);
      queue.push({
        userId: 'debug-test',
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        text: phrase,
        isBot: false,
      });
      log(`voice-greet queued user=debug-test q=${queue.length}`);
      await runQueue();
      return { ok: true };
    } catch (err) {
      log(`voice-greet warn: debugSpeak: ${err.message}`);
      return { ok: false, reason: 'error' };
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
        cooldownUntil: cooldownUntil.get(userId) || 0,
        queueUserIds: queuedUsers,
      });
      if (!decision.ok) return decision;
      if (!hasFfmpeg()) {
        log(`voice-greet warn: ffmpeg missing, skipping speak (looked in ${FFMPEG_CANDIDATES.filter(Boolean).join(', ') || 'none'})`);
        return { ok: false, reason: 'no-ffmpeg' };
      }
      const member = newState?.member || oldState?.member || guild.members?.cache?.get(userId);
      const user = member?.user || newState?.member?.user;
      const rawName = member?.displayName || user?.globalName || user?.username || 'toi';
      const name = cleanName(rawName);
      const picked = pickPhrase(name, lastPhrase.get(userId));
      lastPhrase.set(userId, picked.index);
      if (queue.length >= maxQueue) {
        log(`voice-greet skip user=${userId} reason=queue-full`);
        return { ok: false, reason: 'queue-full' };
      }
      cooldownUntil.set(userId, now + cooldownMs);
      queuedUsers.add(userId);
      queue.push({
        userId,
        guildId: guild.id,
        channelId: newChannelId,
        text: picked.text,
        isBot: Boolean(user?.bot || member?.user?.bot),
      });
      log(`voice-greet queued user=${userId} bot=${user?.bot ? 'yes' : 'no'} q=${queue.length}`);
      setTimeout(() => { runQueue().catch((err) => log(`voice-greet warn: queue: ${err.message}`)); }, 0).unref?.();
      return { ok: true, text: picked.text, name };
    } catch (err) {
      log(`voice-greet warn: handle failed: ${err.message}`);
      return { ok: false, reason: 'error' };
    }
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
  fetchTtsMp3,
  hasFfmpeg,
  findFfmpeg,
  transcodeToPcm,
  flagOn,
  createVoiceGreeter,
};
