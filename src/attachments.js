'use strict';

/**
 * Image attachments for act.sh / Discord replies.
 * Accepts local paths (box) or already-inlined base64 (Fly).
 * Never logs file contents or tokens.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TYPES = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

class AttachError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'AttachError';
    this.code = code;
    this.exitCode = code;
  }
}

function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return TYPES.png;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return TYPES.jpeg;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return TYPES.gif;
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return TYPES.webp;
  }
  return null;
}

function safeFilename(name, ext) {
  const base = path.basename(String(name || 'image')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const trimmed = base.replace(/^\.+/, '') || 'image';
  const hasExt = /\.(png|jpe?g|gif|webp)$/i.test(trimmed);
  return hasExt ? trimmed.slice(0, 80) : `${trimmed.slice(0, 76)}.${ext || 'png'}`;
}

function decodeData(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s);
  const b64 = m ? m[1] : s;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    throw new AttachError('error: invalid base64 in files[].data', 2);
  }
}

function asSpec(entry) {
  if (typeof entry === 'string') return { path: entry };
  if (entry && typeof entry === 'object') return entry;
  throw new AttachError('error: files entries must be a path or an object', 2);
}

function loadOne(entry, index, opts = {}) {
  const spec = asSpec(entry);
  let buf;
  let suggested = spec.name || spec.filename || (spec.path ? path.basename(spec.path) : `image-${index + 1}`);
  if (spec.data != null && spec.data !== '') {
    buf = decodeData(spec.data);
  } else if (spec.path) {
    const p = String(spec.path);
    if (!p || p.includes('\0')) throw new AttachError('error: invalid file path', 2);
    try {
      buf = fs.readFileSync(p);
    } catch (err) {
      const code = err && err.code === 'ENOENT' ? 'not found' : 'unreadable';
      throw new AttachError(`error: file ${code}: ${safeFilename(p, 'png')}`, 2);
    }
  } else {
    throw new AttachError('error: each file needs a local path or base64 data', 2);
  }
  if (buf.length > MAX_BYTES) {
    throw new AttachError(`error: file too large (${buf.length} bytes, max ${MAX_BYTES} per image)`, 2);
  }
  if (buf.length === 0) throw new AttachError('error: file is empty', 2);
  const kind = detectImage(buf);
  if (!kind) {
    throw new AttachError('error: file is not a valid image (png, jpg, webp or gif)', 2);
  }
  const name = safeFilename(suggested, kind.ext);
  const out = {
    name,
    content_type: kind.mime,
    bytes: buf.length,
    buffer: buf,
  };
  if (opts.keepData) out.data = buf.toString('base64');
  return out;
}

function loadFiles(list, opts = {}) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new AttachError('error: files must be an array', 2);
  if (list.length > MAX_FILES) {
    throw new AttachError(`error: too many files (${list.length}, max ${MAX_FILES})`, 2);
  }
  return list.map((entry, i) => loadOne(entry, i, opts));
}

function collectFromBodyAndCli(body, cliPaths = []) {
  const fromJson = Array.isArray(body && body.files) ? body.files.slice() : [];
  const fromCli = (cliPaths || []).map((p) => ({ path: p }));
  return fromJson.concat(fromCli);
}

function inlineBody(body, cliPaths = []) {
  const specs = collectFromBodyAndCli(body, cliPaths);
  if (!specs.length) {
    const out = { ...body };
    delete out.files;
    return { body: out, files: [] };
  }
  const files = loadFiles(specs, { keepData: true });
  const out = { ...body };
  out.files = files.map((f) => ({
    name: f.name,
    content_type: f.content_type,
    data: f.data,
  }));
  return { body: out, files };
}

function describeFiles(files) {
  return (files || []).map((f) => `${f.name}:${f.bytes || f.buffer && f.buffer.length || 0}`).join(',') || 'none';
}

function toDiskless(files) {
  return (files || []).map((f) => ({
    name: f.name,
    content_type: f.content_type,
    bytes: f.bytes,
    buffer: f.buffer,
  }));
}

function buildDiscordForm(payload, files) {
  const form = new FormData();
  const attachments = (files || []).map((f, i) => ({
    id: String(i),
    filename: f.name,
  }));
  const body = { ...payload, attachments };
  form.append('payload_json', JSON.stringify(body));
  (files || []).forEach((f, i) => {
    const blob = new Blob([f.buffer], { type: f.content_type || 'application/octet-stream' });
    form.append(`files[${i}]`, blob, f.name);
  });
  return form;
}

function parseCli(argv) {
  const files = [];
  let inline = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--inline') inline = true;
    else if (a === '--file' || a === '-f') {
      const p = argv[++i];
      if (!p) throw new AttachError('error: --file needs a path', 2);
      files.push(p);
    } else if (a.startsWith('--file=')) files.push(a.slice('--file='.length));
    else if (a === '--dry-run') { /* ignore, handled by caller */ }
    else throw new AttachError(`error: unknown argument ${a}`, 2);
  }
  return { files, inline };
}

async function mainInline() {
  const { files } = parseCli(process.argv.slice(2).filter((a) => a !== '--inline'));
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const raw = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8').trim();
  if (!raw) {
    console.error('Usage: act.sh [--dry-run] [--file image.png]... < json');
    process.exit(2);
  }
  let body;
  try { body = JSON.parse(raw); } catch (err) {
    console.error(`error: invalid JSON: ${err.message}`);
    process.exit(2);
  }
  const out = inlineBody(body, files);
  process.stdout.write(JSON.stringify(out.body));
}

module.exports = {
  MAX_FILES,
  MAX_BYTES,
  TYPES,
  AttachError,
  detectImage,
  safeFilename,
  loadFiles,
  loadOne,
  collectFromBodyAndCli,
  inlineBody,
  describeFiles,
  toDiskless,
  buildDiscordForm,
  parseCli,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--inline')) {
    mainInline().catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(err && err.exitCode ? err.exitCode : 1);
    });
  }
}
