'use strict';

/**
 * File attachments for act.sh / Discord replies.
 * Accepts local paths (box) or already-inlined base64 (Fly).
 * Never logs file contents or tokens.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024; // under Discord's 20 MiB default (unboosted)
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // under the 25 MiB Create Message request cap

const IMAGE_TYPES = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
};
const TYPES = IMAGE_TYPES;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'application/toml',
  ini: 'text/plain',
  log: 'text/plain',
  pdf: 'application/pdf',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  css: 'text/css',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/x-python',
  c: 'text/x-c',
  cc: 'text/x-c',
  cpp: 'text/x-c',
  h: 'text/x-c',
  hpp: 'text/x-c',
  rs: 'text/plain',
  go: 'text/plain',
  rb: 'text/plain',
  php: 'text/plain',
  java: 'text/plain',
  sql: 'text/plain',
  sh: 'text/x-shellscript',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  mov: 'video/quicktime',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
});

const ALLOWED_EXTS = new Set(Object.keys(MIME_BY_EXT));

const BLOCKED_EXTS = new Set([
  'exe', 'bat', 'cmd', 'scr', 'msi', 'ps1', 'vbs', 'vbe',
  'jar', 'apk', 'dmg', 'com', 'pif', 'cpl', 'lnk', 'dll',
  'so', 'dylib', 'app', 'deb', 'rpm', 'iso', 'pkg', 'hta',
  'wsf', 'msc', 'reg',
]);

class AttachError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'AttachError';
    this.code = code;
    this.exitCode = code;
  }
}

function extensionOf(name) {
  const base = path.basename(String(name || ''));
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase();
}

function detectImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return IMAGE_TYPES.png;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return IMAGE_TYPES.jpeg;
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return IMAGE_TYPES.gif;
  }
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return IMAGE_TYPES.webp;
  }
  return null;
}

function isZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  return buf[0] === 0x50 && buf[1] === 0x4b
    && ((buf[2] === 0x03 && buf[3] === 0x04)
      || (buf[2] === 0x05 && buf[3] === 0x06)
      || (buf[2] === 0x07 && buf[3] === 0x08));
}

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5
    && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
}

function isGzip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function imageExtMatches(ext, kind) {
  if (!kind) return false;
  if (ext === 'jpg' || ext === 'jpeg') return kind.ext === 'jpg';
  return kind.ext === ext;
}

function safeFilename(name, ext) {
  const fallbackExt = String(ext || 'bin').replace(/^\./, '') || 'bin';
  const base = path.basename(String(name || 'file')).replace(/[^A-Za-z0-9._-]+/g, '_');
  let trimmed = base.replace(/^\.+/, '') || 'file';
  trimmed = trimmed.slice(0, 80);
  if (/\.[A-Za-z0-9]{1,10}$/.test(trimmed)) return trimmed;
  const e = fallbackExt.slice(0, 10);
  return `${trimmed.slice(0, Math.max(1, 80 - e.length - 1))}.${e}`;
}

function decodeData(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^data:[^;]+;base64,(.+)$/s);
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

function assertAllowedExt(ext, label) {
  if (BLOCKED_EXTS.has(ext)) {
    throw new AttachError(`error: executable or installer files are not allowed (.${ext})`, 2);
  }
  if (!ext) {
    throw new AttachError(`error: ${label} needs an allowed file extension`, 2);
  }
  if (!ALLOWED_EXTS.has(ext)) {
    throw new AttachError(`error: file type .${ext} is not allowed`, 2);
  }
}

function resolveType(suggested, buf) {
  let ext = extensionOf(suggested);
  if (!ext) {
    const kind = detectImage(buf);
    if (kind) return { ext: kind.ext, mime: kind.mime };
  }
  assertAllowedExt(ext, 'file');
  if (IMAGE_EXTS.has(ext)) {
    const kind = detectImage(buf);
    if (!kind || !imageExtMatches(ext, kind)) {
      throw new AttachError('error: file is not a valid image (png, jpg, webp or gif)', 2);
    }
    return { ext: ext === 'jpeg' ? 'jpg' : ext, mime: kind.mime };
  }
  if (ext === 'zip' && !isZip(buf)) {
    throw new AttachError('error: file is not a valid zip', 2);
  }
  if (ext === 'pdf' && !isPdf(buf)) {
    throw new AttachError('error: file is not a valid pdf', 2);
  }
  if ((ext === 'gz' || ext === 'tgz') && !isGzip(buf)) {
    throw new AttachError('error: file is not a valid gzip archive', 2);
  }
  return { ext, mime: MIME_BY_EXT[ext] };
}

function readLocalPath(p) {
  if (!p || p.includes('\0')) throw new AttachError('error: invalid file path', 2);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 'not found' : 'unreadable';
    throw new AttachError(`error: file ${code}: ${safeFilename(p, 'bin')}`, 2);
  }
  if (st.isSymbolicLink()) {
    throw new AttachError('error: symbolic links are not allowed', 2);
  }
  if (!st.isFile()) {
    throw new AttachError('error: not a regular file', 2);
  }
  try {
    return fs.readFileSync(p);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 'not found' : 'unreadable';
    throw new AttachError(`error: file ${code}: ${safeFilename(p, 'bin')}`, 2);
  }
}

function loadOne(entry, index, opts = {}) {
  const spec = asSpec(entry);
  const pathExt = spec.path ? extensionOf(spec.path) : '';
  if (pathExt && BLOCKED_EXTS.has(pathExt)) {
    throw new AttachError(`error: executable or installer files are not allowed (.${pathExt})`, 2);
  }
  let suggested = spec.name || spec.filename || (spec.path ? path.basename(spec.path) : `file-${index + 1}`);
  let buf;
  if (spec.data != null && spec.data !== '') {
    buf = decodeData(spec.data);
  } else if (spec.path) {
    buf = readLocalPath(String(spec.path));
  } else {
    throw new AttachError('error: each file needs a local path or base64 data', 2);
  }
  if (buf.length > MAX_BYTES) {
    throw new AttachError(`error: file too large (${buf.length} bytes, max ${MAX_BYTES} per file)`, 2);
  }
  if (buf.length === 0) throw new AttachError('error: file is empty', 2);
  const kind = resolveType(suggested, buf);
  const name = safeFilename(suggested, kind.ext);
  const finalExt = extensionOf(name);
  assertAllowedExt(finalExt, 'file name');
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
  const files = list.map((entry, i) => loadOne(entry, i, opts));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new AttachError(`error: files too large in total (${total} bytes, max ${MAX_TOTAL_BYTES} per message)`, 2);
  }
  return files;
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
    console.error('Usage: act.sh [--dry-run] [--file file.zip]... < json');
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
  MAX_TOTAL_BYTES,
  TYPES,
  IMAGE_TYPES,
  IMAGE_EXTS,
  MIME_BY_EXT,
  ALLOWED_EXTS,
  BLOCKED_EXTS,
  AttachError,
  detectImage,
  extensionOf,
  safeFilename,
  loadFiles,
  loadOne,
  collectFromBodyAndCli,
  inlineBody,
  describeFiles,
  toDiskless,
  buildDiscordForm,
  parseCli,
  isZip,
  isPdf,
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
