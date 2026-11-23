'use strict';

/**
 * Collect image attachments and embed images/thumbnails for a Discord message
 * payload. Pure helpers, no I/O — used by the bridge and unit tests.
 */

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_COUNT = 4;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function normalizeType(value) {
  if (!value) return '';
  const base = String(value).split(';')[0].trim().toLowerCase();
  if (base === 'image/jpg') return 'image/jpeg';
  return base;
}

function isAllowedType(value) {
  return ALLOWED_TYPES.has(normalizeType(value));
}

function inferType(filename, url) {
  const s = `${filename || ''} ${url || ''}`.toLowerCase();
  if (/\.png(?:$|[?#])/u.test(s)) return 'image/png';
  if (/\.jpe?g(?:$|[?#])/u.test(s)) return 'image/jpeg';
  if (/\.webp(?:$|[?#])/u.test(s)) return 'image/webp';
  if (/\.gif(?:$|[?#])/u.test(s)) return 'image/gif';
  return '';
}

function basenameFromUrl(url) {
  try {
    const path = String(url).split('?')[0].split('#')[0];
    const name = path.slice(path.lastIndexOf('/') + 1);
    return name || '';
  } catch {
    return '';
  }
}

function asList(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection.filter(Boolean);
  if (typeof collection.values === 'function') return [...collection.values()].filter(Boolean);
  if (typeof collection === 'object') return Object.values(collection).filter(Boolean);
  return [];
}

function toImage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.proxyURL || raw.proxy_url || null;
  if (!url || typeof url !== 'string') return null;
  const filename = raw.name || raw.filename || basenameFromUrl(url) || 'image';
  const contentType = normalizeType(raw.contentType || raw.content_type) || inferType(filename, url);
  const sizeRaw = raw.size;
  const size = sizeRaw === undefined || sizeRaw === null || sizeRaw === '' ? null : Number(sizeRaw);
  if (size !== null && (!Number.isFinite(size) || size > IMAGE_MAX_BYTES)) return null;
  if (contentType && !isAllowedType(contentType)) return null;
  const widthRaw = raw.width;
  const heightRaw = raw.height;
  const width = widthRaw === undefined || widthRaw === null || widthRaw === '' ? null : Number(widthRaw);
  const height = heightRaw === undefined || heightRaw === null || heightRaw === '' ? null : Number(heightRaw);
  return {
    url,
    filename,
    content_type: contentType || null,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null,
    size: size !== null && Number.isFinite(size) ? size : null,
  };
}

/**
 * Attachments need a recognized image type (header or inferred from the name).
 * Embed image/thumbnail fields are already images; we still skip known-bad types.
 */
function collectImages(message) {
  if (!message) return [];
  const out = [];
  const seen = new Set();
  const add = (raw, requireType) => {
    if (out.length >= IMAGE_MAX_COUNT) return;
    const img = toImage(raw);
    if (!img) return;
    if (requireType && !isAllowedType(img.content_type)) return;
    if (seen.has(img.url)) return;
    seen.add(img.url);
    out.push(img);
  };

  for (const attachment of asList(message.attachments)) add(attachment, true);

  for (const embed of asList(message.embeds)) {
    if (!embed || typeof embed !== 'object') continue;
    if (embed.image) add(embed.image, false);
    if (embed.thumbnail) add(embed.thumbnail, false);
  }

  return out;
}

/**
 * Images are only forwarded when the message is clearly aimed at the bot
 * (mention, alias, reply to the bot, or a DM). Never for other bots, and
 * never for ambient triggers (keyword-only in AGENTS, etc.).
 */
function shouldAttachImages({ authorIsBot, mentioned, named, replyToBot, isDm } = {}) {
  if (authorIsBot) return false;
  return Boolean(mentioned || named || replyToBot || isDm);
}

function withImages(target, message, include) {
  if (!include || !target) return target;
  const list = collectImages(message);
  if (list.length) target.images = list;
  else delete target.images;
  return target;
}

module.exports = {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  collectImages,
  shouldAttachImages,
  withImages,
};
