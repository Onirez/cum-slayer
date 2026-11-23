#!/usr/bin/env node
'use strict';
/**
 * Per-user memory CLI (routine tool `user`).
 *   user.sh get <user_id> [n]                    notes + last n messages (default 20)
 *   user.sh history <user_id> [n] [--channel <id>] [--search <text>]
 *   user.sh note <user_id> <author_id> <text>    add a short factual note (<=200 chars)
 *   user.sh unnote <user_id> <note_id>           remove one note
 *   user.sh forget <user_id> [all|notes|history] delete stored data
 *   user.sh optout <user_id> | optin <user_id>   stop / resume logging this user
 *   user.sh list [n]                             most recently active users
 * --dry-run anywhere: write commands only report what they would do.
 */
const path = require('path');
const um = require('./usermem');

let legacyMemoryDir;
try { legacyMemoryDir = require('./config').MEMORY_DIR; } catch { legacyMemoryDir = path.join(__dirname, 'data', 'memory'); }

function out(o) { console.log(JSON.stringify(o, null, 2)); }
function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('Usage: user.sh <get|history|note|unnote|forget|optout|optin|list> ... [--dry-run]');
  process.exit(2);
}

async function main() {
  let argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run') || process.env.DRY_RUN === '1';
  argv = argv.filter((a) => a !== '--dry-run');
  const opt = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v ?? null;
  };
  const channelId = opt('--channel');
  const search = opt('--search');
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'get': {
        if (!rest[0]) usage('missing user_id');
        const n = Math.min(100, Number(rest[1]) || 20);
        out(um.contextFor(rest[0], { limit: n, max: 500 }));
        return;
      }
      case 'history': {
        if (!rest[0]) usage('missing user_id');
        const h = um.history(rest[0], { limit: Number(rest[1]) || 50, channelId, search, max: 500 });
        out({ userId: rest[0], channel: channelId || undefined, search: search || undefined, ...h });
        return;
      }
      case 'note': {
        const [uid, by, ...words] = rest;
        if (!uid || !by || !words.length) usage('note <user_id> <author_id> <text>');
        out(um.addNote(uid, by, words.join(' '), { dryRun }));
        return;
      }
      case 'unnote': {
        if (!rest[0] || !rest[1]) usage('unnote <user_id> <note_id>');
        out(um.removeNote(rest[0], rest[1], { dryRun }));
        return;
      }
      case 'forget': {
        if (!rest[0]) usage('missing user_id');
        const what = rest[1] || 'all';
        if (!['all', 'notes', 'history'].includes(what)) usage('forget <user_id> [all|notes|history]');
        out(await um.forget(rest[0], what, { dryRun, legacyMemoryDir }));
        return;
      }
      case 'optout':
      case 'optin': {
        if (!rest[0]) usage('missing user_id');
        um.assertId(rest[0]);
        if (!dryRun) um.setOptout(rest[0], cmd === 'optout');
        out({ userId: rest[0], optedOut: cmd === 'optout', dryRun: dryRun || undefined });
        return;
      }
      case 'list':
        out({ users: um.listUsers(Math.min(100, Number(rest[0]) || 30)) });
        return;
      default:
        usage(cmd ? `unknown command ${cmd}` : null);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
}
main();
