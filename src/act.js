#!/usr/bin/env node
'use strict';

/**
 * Combined fast action: reply (first), then react, then memory/skill writes.
 * Reads one JSON object from stdin. Secrets stay in the environment.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  sanitizeMassMentions,
  splitContent,
  allowedMentions,
  discordRequest,
  encodeReactionEmoji,
} = require('./lib');

const { runActions, createPlan, classify } = require('./mod');
const scope = require('./scope');
const slash = require('./slash');
const attachments = require('./attachments');

const DIR = __dirname;

function usage() {
  console.error('Usage: act.sh [--dry-run] [--file image.png]... < json');
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

function runCli(script, args, dryRun) {
  if (dryRun) {
    console.log(`dry-run node ${path.basename(script)} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
    return { ok: true, stdout: '', stderr: '' };
  }
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: DIR,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function contentChunksForPost(text, hasFiles) {
  const chunks = splitContent(sanitizeMassMentions(text || '')).filter(Boolean);
  if (chunks.length) return chunks;
  return hasFiles ? [''] : [];
}

async function postChannelMessage({ channelId, body, files, first, dryRun }) {
  const form = first && files && files.length ? attachments.buildDiscordForm(body, files) : undefined;
  return discordRequest({
    method: 'POST',
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    body: form ? undefined : body,
    form,
    dryRun,
  });
}

async function sendReply(channelId, messageId, text, dryRun, files = []) {
  const contentChunks = contentChunksForPost(text, files.length > 0);
  const ids = [];
  let first = true;
  for (const chunk of contentChunks) {
    const body = {
      content: chunk,
      allowed_mentions: allowedMentions({ repliedUser: first }),
    };
    if (first) {
      body.message_reference = {
        message_id: messageId,
        channel_id: channelId,
        fail_if_not_exists: false,
      };
    }
    const res = await postChannelMessage({ channelId, body, files, first, dryRun });
    if (res.data?.id) ids.push(res.data.id);
    first = false;
  }
  if (!dryRun) {
    const att = files.length ? ` files=${attachments.describeFiles(files)}` : '';
    console.log(`posted reply ids=${ids.join(',') || '(none)'} channel=${channelId} ref=${messageId}${att}`);
  }
  return ids;
}

async function sendStandalone(channelId, text, dryRun, files = []) {
  const clean = sanitizeMassMentions(text || '');
  // Ping only users explicitly written as <@id> in the text (max 3).
  const pings = [...new Set([...clean.matchAll(/<@!?(\d{5,25})>/g)].map((m) => m[1]))].slice(0, 3);
  const contentChunks = contentChunksForPost(text, files.length > 0);
  const ids = [];
  let first = true;
  for (const chunk of contentChunks) {
    const body = { content: chunk, allowed_mentions: allowedMentions({ userIds: first ? pings : [] }) };
    const res = await postChannelMessage({ channelId, body, files, first, dryRun });
    if (res.data?.id) ids.push(res.data.id);
    first = false;
  }
  if (!dryRun) {
    const att = files.length ? ` files=${attachments.describeFiles(files)}` : '';
    console.log(`posted message ids=${ids.join(',') || '(none)'} channel=${channelId} standalone pings=${pings.join(',') || 'none'}${att}`);
  }
  return ids;
}

async function addReaction(channelId, messageId, emoji, dryRun) {
  const encoded = encodeReactionEmoji(emoji);
  await discordRequest({
    method: 'PUT',
    path: `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encoded}/@me`,
    dryRun,
  });
  if (!dryRun) console.log(`reacted channel=${channelId} message=${messageId} emoji=${emoji}`);
}

function parseArgv(argv) {
  const files = [];
  let dryRun = process.env.DRY_RUN === '1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--file' || a === '-f') {
      const p = argv[++i];
      if (!p) {
        console.error('error: --file needs a path');
        process.exit(2);
      }
      files.push(p);
    } else if (a.startsWith('--file=')) files.push(a.slice('--file='.length));
    else usage();
  }
  return { files, dryRun };
}

function loadRequestFiles(body, cliPaths) {
  try {
    const specs = attachments.collectFromBodyAndCli(body, cliPaths);
    if (body && body.files) delete body.files;
    return attachments.toDiskless(attachments.loadFiles(specs, { keepData: false }));
  } catch (err) {
    if (err && err.name === 'AttachError') {
      console.error(err.message);
      process.exit(err.exitCode || 2);
    }
    throw err;
  }
}

async function main() {
  const { files: cliFiles, dryRun } = parseArgv(process.argv.slice(2));
  let raw = (await readStdin()).trim();
  if (!raw) usage();

  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    console.error(`error: invalid JSON: ${err.message}`);
    process.exit(2);
  }
  raw = '';

  const files = loadRequestFiles(body, cliFiles);
  const channelId = body.channel_id ? String(body.channel_id) : '';
  const messageId = body.message_id ? String(body.message_id) : '';
  const interactionId = body.interaction_id ? String(body.interaction_id) : '';
  const replyText = body.reply == null ? '' : String(body.reply);
  const hasFiles = files.length > 0;
  const reply = replyText !== '' || hasFiles ? replyText : null;
  const react = body.react == null || body.react === '' ? null : String(body.react);
  const memoryAppend = Array.isArray(body.memory_append) ? body.memory_append : [];
  const userNotes = Array.isArray(body.user_notes) ? body.user_notes.slice(0, 3) : [];
  const skillCreate = body.skill_create && typeof body.skill_create === 'object' ? body.skill_create : null;
  const authorId = body.author_id ? String(body.author_id) : '';
  const actions = Array.isArray(body.actions) ? body.actions : [];

  if ((reply !== null || react || hasFiles) && !channelId && !interactionId) {
    console.error('error: channel_id is required when reply, files or react is set');
    process.exit(2);
  }
  if (hasFiles && interactionId) {
    console.error('error: image attachments are not supported on interaction follow-ups');
    process.exit(2);
  }
  if (react && !messageId) {
    console.error('error: message_id is required when react is set');
    process.exit(2);
  }

  const results = { reply: null, react: null, actions: [], plan: null, memory_append: [], user_notes: [], skill_create: null };

  // /fiche follow-up: edit the deferred interaction. The token stays in the
  // bridge store and is never accepted from the JSON (ignore body.token).
  if (interactionId) {
    const rec = slash.getPending(interactionId);
    if (!rec) {
      console.error('error: unknown or expired interaction_id');
      process.exit(3);
    }
    if (reply !== null) {
      try {
        results.reply = await slash.followUpFiche({
          applicationId: rec.application_id,
          token: rec.token,
          content: reply,
          dryRun,
        });
        if (!dryRun) slash.deletePending(interactionId);
        console.log(`posted fiche follow-up interaction_id=${interactionId} dry=${dryRun ? 1 : 0}`);
      } catch (err) {
        console.error(`error: ${err.message}`);
        process.exit(1);
      }
    }
  } else {
    // Discord Agent Rules: no unsolicited messages. The target must be a
    // recorded bridge trigger, or the channel must be in AGENTS / an interacted DM.
    const trig = messageId ? scope.triggerRecord(messageId) : null;
    if ((reply !== null || react !== null || hasFiles) && !trig) {
      try { await scope.assertMaySpeakIn(channelId); } catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(3);
      }
    }

    // Reply first for speed. message_id null => standalone message in channel_id
    // (e.g. daily_roast); the guard above only lets that through in AGENTS
    // channels, channels with a recent trigger, or interacted DMs.
    if (reply !== null && !messageId) {
      results.reply = await sendStandalone(channelId, reply, dryRun, files);
    } else if (reply !== null) {
      results.reply = await sendReply(channelId, messageId, reply, dryRun, files);
      if (!dryRun && trig && trig.author_id) scope.recordInteraction(trig.author_id, 'replied');
    }
  }

  if (react !== null) {
    await addReaction(channelId, messageId, react, dryRun);
    results.react = react;
  }

  // Discord server actions. Read helpers run now; every mutating action is
  // validated and posted as a plan with Confirmer/Annuler buttons and is only
  // executed by bridge.js after the requester confirms (see AGENTS.md).
  const reads = actions.filter((a) => classify(String(a?.type || '')) === 'read');
  const mutating = actions.filter((a) => classify(String(a?.type || '')) !== 'read');
  if (reads.length) {
    results.actions = await runActions({ actions: reads, dryRun });
    for (const r of results.actions) {
      console.log(`action ${r.type}: ${r.ok ? 'ok ' + JSON.stringify(r.result) : 'FAILED ' + r.error}`);
    }
  }
  if (mutating.length) {
    const plan = await createPlan({ actions: mutating, channelId, messageId, claimedAuthor: authorId, dryRun });
    results.plan = plan.ok
      ? { ok: true, plan_id: plan.plan_id, status: 'pending', plan_message_id: plan.plan_message_id || null, dryRun: Boolean(plan.dryRun) }
      : { ok: false, error: plan.error };
    if (plan.ok) {
      console.log(`plan ${plan.plan_id}: POSTED, PENDING CONFIRMATION — ${mutating.length} action(s) NOT executed yet; the requester must click Confirmer (expires in 10 min).${plan.dryRun ? ' (dry-run: not stored/posted)' : ''}`);
    } else {
      console.log(`plan REFUSED: ${plan.error} — nothing posted, nothing executed.`);
    }
  }

  // Writes after the Discord send.
  for (const item of memoryAppend) {
    const subject = String(item.subject || '').trim();
    const author = String(item.author || '').trim();
    const text = String(item.text || '').trim();
    if (!subject || !author || !text) {
      console.error('error: memory_append items need subject, author, and text');
      process.exit(2);
    }
    const ran = runCli(path.join(DIR, 'memory.js'), ['append', subject, author, text], dryRun);
    if (!ran.ok) process.exit(ran.status || 1);
    results.memory_append.push({ subject, author });
  }

  // Per-user notes (usermem). A refused/invalid note never aborts the act.
  if (userNotes.length) {
    const um = require('./usermem');
    for (const item of userNotes) {
      try {
        const r = um.addNote(String(item.subject || '').trim(), String(item.author || '').trim(), String(item.text || ''), { dryRun });
        results.user_notes.push({ subject: r.userId, saved: Boolean(r.saved), dryRun: r.dryRun || undefined, reason: r.reason || undefined });
      } catch (e) {
        results.user_notes.push({ subject: String(item.subject || ''), saved: false, reason: e.message });
      }
    }
  }

  if (skillCreate) {
    const author = String(skillCreate.author || '').trim();
    const trigger = String(skillCreate.trigger || '').trim();
    const rule = String(skillCreate.rule || '').trim();
    if (!author || !trigger || !rule) {
      console.error('error: skill_create needs author, trigger, and rule');
      process.exit(2);
    }
    const ran = runCli(path.join(DIR, 'skills.js'), ['create', author, trigger, '--', rule], dryRun);
    if (!ran.ok) process.exit(ran.status || 1);
    results.skill_create = { author, trigger, rule };
  }

  console.log(JSON.stringify({ ok: true, dryRun, results }));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
