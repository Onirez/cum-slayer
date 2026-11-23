#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const MEMORY_MAX_LENGTH = 2000;
const config = require('./config');
const root = config.MEMORY_DIR;

function memoryPath(userId) {
  if (!/^\d{5,30}$/.test(userId)) {
    console.error('error: user id must be a numeric Discord snowflake');
    process.exit(2);
  }
  return path.join(root, `${userId}.json`);
}

function readMemory(userId) {
  const p = memoryPath(userId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeMemory(mem) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = memoryPath(mem.userId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mem, null, 2) + '\n');
  fs.renameSync(tmp, memoryPath(mem.userId));
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'get') {
  const userId = rest[0];
  if (!userId) {
    console.error('Usage: memory.sh get <user_id>');
    process.exit(2);
  }
  const mem = readMemory(userId);
  console.log(JSON.stringify({
    userId,
    memoryText: mem?.memoryText ?? null,
    updatedAt: mem?.updatedAt ?? null,
  }, null, 2));
  process.exit(0);
}

if (cmd === 'list') {
  fs.mkdirSync(root, { recursive: true });
  const files = fs.readdirSync(root).filter((f) => f.endsWith('.json'));
  const items = files.map((f) => {
    const mem = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    return { userId: mem.userId, memoryText: mem.memoryText, updatedAt: mem.updatedAt };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 10);
  console.log(JSON.stringify({ memories: items }, null, 2));
  process.exit(0);
}

if (cmd === 'append') {
  // memory.sh append <subject_id> <author_id> <facts...>
  const subjectId = rest[0];
  const authorId = rest[1];
  const facts = rest.slice(2).join(' ').trim();
  if (!subjectId || !authorId || !facts) {
    console.error('Usage: memory.sh append <subject_user_id> <author_user_id> <facts>');
    process.exit(2);
  }
  if (facts.length > 400) {
    console.error('error: facts must be at most 400 characters');
    process.exit(2);
  }
  const current = readMemory(subjectId);
  const attributed = authorId !== subjectId
    ? `<@${authorId}> indique : ${facts}`
    : facts;
  const addition = attributed.trim();
  let nextText;
  if (!current || !current.memoryText) {
    nextText = `<@${subjectId}> ${addition}`;
  } else {
    nextText = `${current.memoryText.trim()} ${addition}`;
  }
  if (nextText.length > MEMORY_MAX_LENGTH) {
    console.log(JSON.stringify({
      userId: subjectId,
      appended: false,
      reason: `memory budget ${MEMORY_MAX_LENGTH} chars would be exceeded (${nextText.length})`,
      memoryText: current?.memoryText ?? null,
      updatedAt: current?.updatedAt ?? null,
    }, null, 2));
    process.exit(0);
  }
  const saved = {
    userId: subjectId,
    memoryText: nextText,
    updatedAt: new Date().toISOString(),
  };
  writeMemory(saved);
  console.log(JSON.stringify({ userId: subjectId, appended: true, memoryText: saved.memoryText, updatedAt: saved.updatedAt }, null, 2));
  process.exit(0);
}

console.error('Usage: memory.sh <get|list|append> ...');
process.exit(2);
