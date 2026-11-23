'use strict';

/**
 * Central configuration. Identity IDs have documented defaults for the
 * production guild (Le Royaume) and can be overridden with environment
 * variables. Secrets are never stored here: they come from the environment
 * only (see .env.example).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function env(name, fallback = '') {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function firstEnv(names, fallback = '') {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
  }
  return fallback;
}

function envList(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback.slice();
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function flagOn(name, fallback = 'on') {
  return !['0', 'false', 'no', 'off', ''].includes(
    String(process.env[name] ?? fallback).trim().toLowerCase(),
  );
}

function optionalFile(filePath) {
  if (!filePath) return '';
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

const DATA_DIR = env('DATA_DIR', path.join(ROOT, 'data'));

const config = {
  ROOT,
  SRC_DIR: path.join(ROOT, 'src'),
  SCRIPTS_DIR: path.join(ROOT, 'scripts'),
  DATA_DIR,
  MEMORY_DIR: env('MEMORY_DIR', path.join(DATA_DIR, 'memory')),
  SKILLS_FILE: env('SKILLS_FILE', path.join(DATA_DIR, 'skills.json')),
  TRIGGERS_FILE: path.join(DATA_DIR, 'triggers.json'),
  INTERACTIONS_FILE: path.join(DATA_DIR, 'interactions.json'),
  CONTACTS_FILE: env('ROAST_CONTACTS_FILE', path.join(DATA_DIR, 'agents_contacts.json')),
  ROAST_STATE_FILE: env('ROAST_STATE_FILE', path.join(DATA_DIR, 'daily_roast.json')),
  PLANS_FILE: env('PLANS_FILE', path.join(DATA_DIR, 'pending_plans.json')),
  STATUSES_FILE: path.join(DATA_DIR, 'statuses.json'),
  STATUS_OVERRIDE_FILE: path.join(DATA_DIR, 'status_override.json'),
  CONSUMED_FILE: path.join(DATA_DIR, 'triggers_consumed.json'),
  HEARTBEAT_FILE: path.join(DATA_DIR, 'heartbeat'),
  MOD_LOG: env('MOD_LOG', path.join(ROOT, 'mod.log')),

  // Identity — defaults are the production bot / guild, overridable via env.
  BOT_APP_ID: env('BOT_APP_ID', '1574150367325855856'),
  CREATOR_ID: env('CREATOR_ID', '965544860528562216'),
  GUILD_ID: firstEnv(['GUILD_ID', 'MOD_GUILD_ID'], '1095123126746099834'),
  AGENTS_CATEGORY_ID: env('AGENTS_CATEGORY_ID', '1574094410830844105'),
  FALLBACK_CHANNEL_ID: firstEnv(['FALLBACK_CHANNEL_ID', 'ROAST_CHANNEL_ID'], '1571542249051783228'),
  ALLOWED_GUILDS: envList('ALLOWED_GUILDS', ['1095123126746099834']),
  BOT_ALIASES: envList('BOT_ALIASES', ['cûm slayer', 'cum slayer', 'slayer']),

  // Documented example channel IDs for the production guild (used by tests).
  CHANNELS: {
    agent1: env('CHANNEL_AGENT_1', '1571542249051783228'),
    agent2: env('CHANNEL_AGENT_2', '1455708291731820627'),
    agent3: env('CHANNEL_AGENT_3', '1574094942085586995'),
    rules: env('CHANNEL_RULES', '1574166939389919392'),
    general: env('CHANNEL_GENERAL', '1455535721850077244'),
    voice: env('CHANNEL_VOICE', '1571320567284367430'),
  },

  ALLOW_DMS: flagOn('ALLOW_DMS', '1'),
  AUTO_VOICE: flagOn('AUTO_VOICE', 'on'),
  DAILY_ROAST: flagOn('DAILY_ROAST', 'on'),

  USER_COOLDOWN_MS: Number(process.env.USER_COOLDOWN_MS || 10_000),
  GLOBAL_WINDOW_MS: Number(process.env.GLOBAL_WINDOW_MS || 10 * 60 * 1000),
  GLOBAL_MAX: Number(process.env.GLOBAL_MAX || 20),
  WEBHOOK_TIMEOUT_MS: Number(process.env.WEBHOOK_TIMEOUT_MS || 15_000),
  BOT_LOOP_MAX: Number(process.env.BOT_LOOP_MAX || 5),
  BOT_LOOP_IDLE_MS: Number(process.env.BOT_LOOP_IDLE_MS || process.env.BOT_LOOP_WINDOW_MS || 20_000),
  BOT_AUTHOR_COOLDOWN_MS: Number(process.env.BOT_AUTHOR_COOLDOWN_MS || 5_000),
  AUTO_VOICE_DEBOUNCE_MS: Number(process.env.AUTO_VOICE_DEBOUNCE_MS || 5_000),
  AUTO_VOICE_RESYNC_MS: Number(process.env.AUTO_VOICE_RESYNC_MS || 60_000),

  flagOn,
  env,
};

function routineWebhookUrl() {
  return firstEnv(['ROUTINE_WEBHOOK_URL', 'GROK_WEBHOOK_URL'], '')
    || optionalFile(process.env.ROUTINE_WEBHOOK_URL_FILE);
}

function routineWebhookKey() {
  return firstEnv(['ROUTINE_WEBHOOK_KEY', 'GROK_WEBHOOK_KEY'], '');
}

config.routineWebhookUrl = routineWebhookUrl;
config.routineWebhookKey = routineWebhookKey;
Object.defineProperty(config, 'ROUTINE_WEBHOOK_URL', { get: routineWebhookUrl, enumerable: true });
Object.defineProperty(config, 'ROUTINE_WEBHOOK_KEY', { get: routineWebhookKey, enumerable: true });

module.exports = config;
