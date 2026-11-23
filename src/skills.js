#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL_TRIGGER_MAX_LENGTH = 120;
const SKILL_RULE_MAX_LENGTH = 600;
const config = require('./config');
const file = config.SKILLS_FILE;

function load() {
  if (!fs.existsSync(file)) return { skills: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function toSingleLine(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'list') {
  const doc = load();
  const triggers = doc.skills
    .filter((s) => !s.deletedAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((s) => ({ id: s.id, trigger: s.trigger }));
  console.log(JSON.stringify(triggers, null, 2));
  process.exit(0);
}

if (cmd === 'open') {
  const skillId = rest[0];
  if (!skillId) {
    console.error('Usage: skills.sh open <skill_id>');
    process.exit(2);
  }
  const doc = load();
  const skill = doc.skills.find((s) => s.id === skillId && !s.deletedAt);
  if (!skill) {
    console.error('error: skill not found');
    process.exit(1);
  }
  skill.usageCount = (skill.usageCount || 0) + 1;
  save(doc);
  console.log(JSON.stringify({
    skillId: skill.id,
    trigger: skill.trigger,
    rule: skill.rule,
    usageCount: skill.usageCount,
  }, null, 2));
  process.exit(0);
}

if (cmd === 'create') {
  // skills.sh create <author_id> <trigger> -- <rule>
  const authorId = rest[0];
  const sep = rest.indexOf('--');
  if (!authorId || sep < 1) {
    console.error('Usage: skills.sh create <author_user_id> <trigger> -- <rule>');
    process.exit(2);
  }
  const trigger = toSingleLine(rest.slice(1, sep).join(' '));
  const rule = toSingleLine(rest.slice(sep + 1).join(' '));
  if (trigger.length < 3 || trigger.length > SKILL_TRIGGER_MAX_LENGTH) {
    console.error(`error: trigger must be 3-${SKILL_TRIGGER_MAX_LENGTH} chars (got ${trigger.length})`);
    process.exit(2);
  }
  if (rule.length < 3 || rule.length > SKILL_RULE_MAX_LENGTH) {
    console.error(`error: rule must be 3-${SKILL_RULE_MAX_LENGTH} chars (got ${rule.length})`);
    process.exit(2);
  }
  const skill = {
    id: crypto.randomUUID(),
    trigger,
    rule,
    createdByUserId: authorId,
    usageCount: 0,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };
  const doc = load();
  doc.skills.push(skill);
  save(doc);
  console.log(JSON.stringify({ skillId: skill.id, trigger: skill.trigger, rule: skill.rule }, null, 2));
  process.exit(0);
}

console.error('Usage: skills.sh <list|open|create> ...');
process.exit(2);
