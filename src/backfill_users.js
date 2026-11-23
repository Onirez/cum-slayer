#!/usr/bin/env node
'use strict';
/**
 * Seed the per-user logs from recent guild channel history (read-only on Discord).
 *   node backfill_users.js [--per-channel 300] [--dry-run] [--self-only]
 * --self-only: light count-only entries for this bot (no content), for /stats.
 * Needs DISCORD_BOT_TOKEN in the environment (never printed). Skips channels the
 * bot cannot read. Merges with existing logs (dedupe by message id).
 */
const um = require('./usermem');
const lifetime = require('./lifetime');

let cfg = {};
try { cfg = require('./config'); } catch { /* box layout */ }
const GUILD_ID = process.env.BACKFILL_GUILD_ID || String(process.env.ALLOWED_GUILDS || cfg.GUILD_ID || '1095123126746099834').split(',')[0].trim();
const BOT_ID = process.env.BOT_APP_ID || cfg.BOT_APP_ID || '1574150367325855856';
const API = 'https://discord.com/api/v10';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const selfOnly = args.includes('--self-only');
const iPer = args.indexOf('--per-channel');
const PER_CHANNEL = Math.min(1000, Math.max(50, Number(iPer >= 0 ? args[iPer + 1] : 300) || 300));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await sleep(Math.ceil((Number(body.retry_after) || 1) * 1000) + 250);
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  }
  return { ok: false, status: 429 };
}

function resolve(m, channelNames) {
  let c = m.content || '';
  for (const u of m.mentions || []) c = c.replace(new RegExp(`<@!?${u.id}>`, 'g'), `@${u.global_name || u.username}`);
  c = c.replace(/<#(\d+)>/g, (_, id) => `#${channelNames.get(id) || id}`);
  if (!c && m.embeds?.length) c = '[embed]';
  return c;
}

async function main() {
  const ch = await api(`/guilds/${GUILD_ID}/channels`);
  if (!ch.ok) throw new Error(`cannot list channels (status ${ch.status})`);
  const channelNames = new Map(ch.data.map((c) => [c.id, c.name]));
  const textChannels = ch.data.filter((c) => c.type === 0 || c.type === 5);
  const perUser = new Map();
  let total = 0;
  const report = [];
  for (const c of textChannels) {
    let before = null;
    let got = 0;
    let status = 'ok';
    while (got < PER_CHANNEL) {
      const q = `?limit=100${before ? `&before=${before}` : ''}`;
      const r = await api(`/channels/${c.id}/messages${q}`);
      if (!r.ok) { status = `skip(${r.status})`; break; }
      if (!r.data.length) break;
      for (const m of r.data) {
        if (!m.author) continue;
        if (selfOnly) {
          if (m.author.id !== BOT_ID) continue;
          // default, reply, and slash-command responses (visible channel messages)
          if (m.type !== 0 && m.type !== 19 && m.type !== 20) continue;
          const entry = um.makeEntry({
            messageId: m.id,
            channelId: c.id,
            channelName: c.name,
            timestamp: Date.parse(m.timestamp),
            name: m.member?.nick || m.author.global_name || m.author.username,
            bot: true,
            light: true,
          });
          if (!perUser.has(m.author.id)) perUser.set(m.author.id, []);
          perUser.get(m.author.id).push(entry);
          total++;
          continue;
        }
        if (m.author.id === BOT_ID) continue;
        if (m.type !== 0 && m.type !== 19) continue; // default + reply only
        const entry = um.makeEntry({
          messageId: m.id,
          channelId: c.id,
          channelName: c.name,
          timestamp: Date.parse(m.timestamp),
          content: resolve(m, channelNames),
          attachments: (m.attachments || []).length,
          replyTo: m.message_reference?.message_id || null,
          replyToUser: m.referenced_message?.author?.id || null,
          name: m.member?.nick || m.author.global_name || m.author.username,
          bot: Boolean(m.author.bot),
        });
        if (!perUser.has(m.author.id)) perUser.set(m.author.id, []);
        perUser.get(m.author.id).push(entry);
        total++;
      }
      got += r.data.length;
      before = r.data[r.data.length - 1].id;
      if (r.data.length < 100) break;
      await sleep(300);
    }
    report.push(`${c.name}:${got}${status === 'ok' ? '' : ` ${status}`}`);
  }
  let written = 0;
  if (!dryRun) {
    try { lifetime.ensureSeeded(); } catch { /* still count unique ids */ }
    for (const [id, entries] of perUser) {
      await um.mergeEntries(id, entries);
      for (const e of entries) {
        if (e && e.m) lifetime.noteGuildMessage(e.m);
      }
      written++;
    }
    try { lifetime.flush(); } catch { /* ignore */ }
  }
  console.log(JSON.stringify({ guild: GUILD_ID, dryRun, selfOnly, perChannel: PER_CHANNEL, channels: report, messages: total, users: perUser.size, usersWritten: written }, null, 1));
}

main().catch((err) => { console.error(`error: ${err.message}`); process.exit(1); });
