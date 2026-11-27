'use strict';

/**
 * Minimal Microsoft Edge neural TTS client (no API key, no Python).
 * Uses the public Read Aloud WebSocket and a Sec-MS-GEC v2 token.
 * Google Translate TTS stays the fallback in voice_greet.js.
 */

const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const GEC_VERSION = '2-143.0.3650.96';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.';
const WIN_EPOCH = 11644473600;
const AUDIO_DELIM = Buffer.from('Path:audio\r\n');
const JSON_XML_DELIM = '\r\n\r\n';

// Remy multilingual auto-switches to English on names like "Dave Ops".
// Edge Read Aloud rejects <lang xml:lang> (no audio), so we use monolingual
// Henri to keep every greeting in French. Pitch and rate stay natural.
const DEFAULT_VOICE = 'fr-FR-HenriNeural';
const DEFAULT_PITCH = '+0%';
const DEFAULT_RATE = '+0%';
const DEFAULT_LANG = 'fr-FR';

const SWAP_FIRST_WORD = { swappedWord: 0xEF0569FB, swappedSum: 0x76F50F34, swappedProduct: 0xC3EFEA97 };
const SWAP_SECOND_WORD = { swappedWord: 0xC31713DB, swappedSum: 0x1881CE3C, swappedProduct: 0x35BD1EC9 };
const MIX_FIRST_WORD = [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83];
const MIX_SECOND_WORD = [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69];

let clockOffsetMs = 0;

function swapHalves(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function swapTerm(word, key, multipliers) {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), multipliers.swappedWord);
  const product = Math.imul(swapHalves(sum), multipliers.swappedSum) >>> 0;
  return (Math.imul(swapHalves(product), multipliers.swappedProduct) + product) >>> 0;
}

function swapAndMultiply(value, multipliers) {
  for (const multiplier of multipliers) {
    value = Math.imul(swapHalves(value), multiplier) >>> 0;
  }
  return value;
}

function toUpperHex(bytes) {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

function hashSecMsGecV2(ticksAndToken) {
  const message = Buffer.from(EDGE_COPYRIGHT + ticksAndToken, 'utf8');
  const digest = crypto.createHash('sha256').update(message).digest();
  const firstKey = (digest.readUInt32LE(0) | 1) >>> 0;
  const secondKey = (digest.readUInt32LE(4) | 1) >>> 0;
  const padded = Buffer.alloc(Math.ceil(message.length / 8) * 8);
  message.copy(padded);
  let swapSum = 0;
  let lastSwap = 0;
  let mix = 0;
  let mixSum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = padded.readUInt32LE(offset);
    const secondWord = padded.readUInt32LE(offset + 4);
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST_WORD);
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND_WORD);
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST_WORD);
    mixSum = (mixSum + mix) >>> 0;
    mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND_WORD);
    mixSum = (mixSum + mix) >>> 0;
  }
  const checksum = Buffer.alloc(8);
  checksum.writeUInt32LE((lastSwap ^ mix) >>> 0, 0);
  checksum.writeUInt32LE((swapSum ^ mixSum) >>> 0, 4);
  return `${toUpperHex(checksum)}-${toUpperHex(digest)}`;
}

function secMsGecFromUnixSeconds(unixSeconds) {
  const ticks = Math.floor(Number(unixSeconds)) + WIN_EPOCH;
  const rounded = ticks - (ticks % 300);
  return hashSecMsGecV2(`${rounded * 10000000}${TRUSTED_CLIENT_TOKEN}`);
}

function generateSecMsGec() {
  return secMsGecFromUnixSeconds((Date.now() + clockOffsetMs) / 1000);
}

function escapeSsml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function voiceSettings(overrides = {}) {
  return {
    voice: String(overrides.voice || process.env.TTS_VOICE || DEFAULT_VOICE),
    pitch: String(overrides.pitch || process.env.TTS_PITCH || DEFAULT_PITCH),
    rate: String(overrides.rate || process.env.TTS_RATE || DEFAULT_RATE),
    lang: String(overrides.lang || process.env.TTS_LANG || DEFAULT_LANG),
  };
}

function cacheVoiceTag(settings = voiceSettings()) {
  return `edge:${settings.voice}:${settings.pitch}:${settings.rate}:lang-${settings.lang}`;
}

function buildSsml(text, { voice, pitch, rate, lang = DEFAULT_LANG } = {}) {
  // Edge Read Aloud rejects <lang xml:lang> inside the voice (empty audio).
  // Force French on the speak and voice elements instead. Remy multilingual
  // still auto-detects English on some names, so the default voice is Henri.
  const safeLang = escapeSsml(lang || DEFAULT_LANG);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${safeLang}">`
    + `<voice name="${escapeSsml(voice)}" xml:lang="${safeLang}">`
    + `<prosody pitch="${escapeSsml(pitch)}" rate="${escapeSsml(rate)}">`
    + `${escapeSsml(text)}`
    + `</prosody></voice></speak>`;
}

function requestId() {
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

function synthUrl(id) {
  const sec = generateSecMsGec();
  return `${WSS_URL}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${sec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${id}`;
}

function synthesizeOnce(text, { voice, pitch, rate, lang, timeoutMs }) {
  const id = requestId();
  const chunks = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => done(new Error('edge tts timeout')), timeoutMs);
    const ws = new WebSocket(synthUrl(id), {
      headers: { 'User-Agent': EDGE_UA, Origin: EDGE_ORIGIN },
    });
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(buf);
    };
    ws.on('unexpected-response', (_req, res) => {
      const err = Object.assign(new Error(`edge tts http ${res.statusCode}`), {
        statusCode: res.statusCode,
        serverDate: res.headers?.date,
      });
      try { res.resume(); } catch { /* ignore */ }
      done(err);
    });
    ws.on('error', (err) => done(err));
    ws.on('open', () => {
      const config = `Content-Type:application/json; charset=utf-8\r\nPath:speech.config${JSON_XML_DELIM}`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}';
      const ssml = buildSsml(text, { voice, pitch, rate, lang });
      const request = `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${JSON_XML_DELIM}${ssml}`;
      try {
        ws.send(config);
        ws.send(request);
      } catch (err) {
        done(err);
      }
    });
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.toString('utf8').includes('Path:turn.end')) {
        if (!chunks.length) return done(new Error('edge tts empty audio'));
        return done(null, Buffer.concat(chunks));
      }
      const idx = buf.indexOf(AUDIO_DELIM);
      if (idx !== -1) chunks.push(buf.subarray(idx + AUDIO_DELIM.length));
    });
    ws.on('close', () => {
      if (settled) return;
      if (chunks.length) done(null, Buffer.concat(chunks));
      else done(new Error('edge tts closed with no audio'));
    });
  });
}

async function fetchEdgeTtsMp3(text, dest, timeoutMs = 12_000, overrides = {}) {
  const { voice, pitch, rate, lang } = voiceSettings(overrides);
  const clipped = String(text);
  async function run() {
    const buf = await synthesizeOnce(clipped, { voice, pitch, rate, lang, timeoutMs });
    if (!buf || buf.length < 64 || (buf[0] !== 0xff && buf.slice(0, 3).toString() !== 'ID3')) {
      throw new Error('edge tts response is not mp3');
    }
    fs.writeFileSync(dest, buf);
    return dest;
  }
  try {
    return await run();
  } catch (err) {
    const serverTime = err && err.statusCode === 403 && err.serverDate ? Date.parse(err.serverDate) : NaN;
    if (Number.isFinite(serverTime)) {
      clockOffsetMs = serverTime - Date.now();
      return run();
    }
    throw err;
  }
}

module.exports = {
  DEFAULT_VOICE,
  DEFAULT_PITCH,
  DEFAULT_RATE,
  DEFAULT_LANG,
  buildSsml,
  TRUSTED_CLIENT_TOKEN,
  escapeSsml,
  hashSecMsGecV2,
  secMsGecFromUnixSeconds,
  generateSecMsGec,
  voiceSettings,
  cacheVoiceTag,
  fetchEdgeTtsMp3,
};
