'use strict';

/**
 * Shared helpers for Discord send/context scripts.
 * Secrets are read from the environment only and must never be logged.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_CONTENT = 2000;

function sanitizeMassMentions(text) {
  return String(text ?? '').replace(/@(everyone|here)/giu, '@{$1}');
}

function splitContent(text) {
  const s = String(text ?? '');
  const chunks = [];
  for (let i = 0; i < s.length; i += MAX_CONTENT) chunks.push(s.slice(i, i + MAX_CONTENT));
  return chunks.length ? chunks : [''];
}

function allowedMentions({ repliedUser = false, userIds = [] } = {}) {
  const mentions = { parse: [], replied_user: Boolean(repliedUser) };
  if (userIds.length) mentions.users = userIds.slice(0, 10);
  return mentions;
}

function requireToken() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('error: DISCORD_BOT_TOKEN is not set');
    process.exit(1);
  }
  return token;
}

async function discordRequest({ method, path, body, form, dryRun }) {
  const url = `${DISCORD_API}${path}`;
  const json = form || body === undefined ? undefined : JSON.stringify(body);
  if (dryRun) {
    if (form) {
      const parts = [];
      if (typeof form.entries === 'function') {
        for (const [k, v] of form.entries()) {
          if (k === 'payload_json') {
            try { parts.push(`payload=${JSON.stringify(JSON.parse(String(v)))}`); }
            catch { parts.push('payload_json'); }
          } else {
            const n = v && typeof v === 'object' && (v.name || v.filename) ? (v.name || v.filename) : k;
            const sz = v && typeof v.size === 'number' ? v.size : '';
            parts.push(`${k}:${n}${sz !== '' ? `:${sz}` : ''}`);
          }
        }
      }
      console.log(`dry-run ${method} ${url} multipart ${parts.join(' ') || '(form)'}`);
    } else {
      console.log(`dry-run ${method} ${url}`);
      if (json !== undefined) console.log(json);
    }
    return { dryRun: true, status: 0, data: null };
  }
  const token = requireToken();
  const headers = { Authorization: `Bot ${token}` };
  let payload;
  if (form) {
    // Let fetch set the multipart boundary. Do not set Content-Type.
    payload = form;
  } else {
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    payload = json;
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const snippet = String(text).replace(/\s+/g, ' ').slice(0, 400);
    console.error(`Discord API error status=${res.status} body=${snippet}`);
    process.exit(1);
  }
  return { dryRun: false, status: res.status, data };
}

function encodeReactionEmoji(emoji) {
  const raw = String(emoji ?? '').trim();
  const custom = raw.match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (custom) return `${custom[1]}:${custom[2]}`;
  return encodeURIComponent(raw);
}

module.exports = {
  MAX_CONTENT,
  sanitizeMassMentions,
  splitContent,
  allowedMentions,
  requireToken,
  discordRequest,
  encodeReactionEmoji,
};
