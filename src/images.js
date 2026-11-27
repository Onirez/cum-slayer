'use strict';

/**
 * Collect image/video/file attachments and embed images, thumbnails and
 * video/gifv for a Discord message payload. Pure helpers, no I/O.
 * `files` lists every real attachment (with URL) for humans and bots.
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

const PREVIEW_MAX_EDGE = 1024;

/**
 * Rewrite a Discord CDN / media URL to the media proxy as JPEG (often smaller).
 * Does not set width/height (the proxy would crop). Keeps signed query params.
 * Null if the host is not allowlisted.
 */
function previewUrl(url, maxEdge = PREVIEW_MAX_EDGE) {
  try {
    const u = new URL(String(url));
    const host = (u.hostname || '').toLowerCase();
    if (host !== 'cdn.discordapp.com' && host !== 'media.discordapp.net') return null;
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    if (u.port && u.port !== '443') return null;
    u.hostname = 'media.discordapp.net';
    u.port = '';
    // Do not set width/height: Discord's media proxy crops to a square when
    // both are provided. Resizing is done locally by img.sh / PIL instead.
    u.searchParams.set('format', 'jpeg');
    return u.toString();
  } catch {
    return null;
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
  const preview = previewUrl(url);
  return {
    url,
    preview_url: preview && preview !== url ? preview : preview,
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
 * (mention, alias, reply to the bot, or a DM), or when it is a human
 * conversation-follow after the bot just spoke. Never for other bots, and
 * never for ambient triggers (keyword-only in AGENTS, etc.).
 */
function shouldAttachImages({ authorIsBot, mentioned, named, replyToBot, isDm, follow } = {}) {
  if (authorIsBot) return false;
  return Boolean(mentioned || named || replyToBot || isDm || follow);
}

function withImages(target, message, include) {
  if (!include || !target) return target;
  const list = collectImages(message);
  if (list.length) target.images = list;
  else delete target.images;
  return target;
}



const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_MAX_COUNT = 2;
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

function inferVideoType(filename, url) {
  const s = `${filename || ''} ${url || ''}`.toLowerCase();
  if (/\.mpe?g(?:$|[?#])/u.test(s)) return '';
  if (/\.(?:mp4|m4v)(?:$|[?#])/u.test(s)) return 'video/mp4';
  if (/\.(?:mov|qt)(?:$|[?#])/u.test(s)) return 'video/quicktime';
  if (/\.webm(?:$|[?#])/u.test(s)) return 'video/webm';
  return '';
}

function normalizeVideoType(value, filename, url) {
  const base = normalizeType(value);
  if (base === 'video/x-m4v' || base === 'video/m4v') return 'video/mp4';
  if (base === 'video/mov' || base === 'video/x-quicktime') return 'video/quicktime';
  if (ALLOWED_VIDEO_TYPES.has(base)) return base;
  return inferVideoType(filename, url);
}

function isAllowedVideoType(value) {
  return ALLOWED_VIDEO_TYPES.has(normalizeType(value));
}

function numOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function thumbFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.proxyURL || raw.proxy_url || null;
  if (!url || typeof url !== 'string') return null;
  const proxy = raw.proxyURL || raw.proxy_url || null;
  return {
    url,
    proxy_url: proxy && proxy !== url ? proxy : (proxy || null),
    width: numOrNull(raw.width),
    height: numOrNull(raw.height),
  };
}

function toVideo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.proxyURL || raw.proxy_url || null;
  if (!url || typeof url !== 'string') return null;
  const filename = raw.name || raw.filename || basenameFromUrl(url) || 'video';
  const contentType = normalizeVideoType(raw.contentType || raw.content_type, filename, url);
  const size = numOrNull(raw.size);
  if (size !== null && (size < 0 || size > VIDEO_MAX_BYTES)) return null;
  if (contentType && !isAllowedVideoType(contentType)) return null;
  const duration = numOrNull(raw.duration ?? raw.duration_secs ?? raw.durationSecs);
  const proxy = raw.proxyURL || raw.proxy_url || null;
  const thumbnail = thumbFrom(raw.thumbnail || raw.preview || raw.thumb) || null;
  return {
    url,
    filename,
    content_type: contentType || null,
    width: numOrNull(raw.width),
    height: numOrNull(raw.height),
    size,
    duration,
    proxy_url: proxy && proxy !== url ? proxy : (proxy || null),
    thumbnail,
  };
}

/**
 * Attachments need a recognized video type. Embeds of type video/gifv
 * (Tenor, Giphy, Discord) contribute embed.video plus a thumbnail if any.
 */
function collectVideos(message) {
  if (!message) return [];
  const out = [];
  const seen = new Set();
  const add = (raw, requireType) => {
    if (out.length >= VIDEO_MAX_COUNT) return;
    const vid = toVideo(raw);
    if (!vid) return;
    if (requireType && !isAllowedVideoType(vid.content_type)) return;
    if (seen.has(vid.url)) return;
    seen.add(vid.url);
    out.push(vid);
  };

  for (const attachment of asList(message.attachments)) add(attachment, true);

  for (const embed of asList(message.embeds)) {
    if (!embed || typeof embed !== 'object') continue;
    const typ = String(embed.type || '').toLowerCase();
    if (!embed.video && typ !== 'gifv' && typ !== 'video') continue;
    const video = embed.video && typeof embed.video === 'object' ? { ...embed.video } : {};
    if (!video.url && !video.proxyURL && !video.proxy_url) continue;
    if (!video.name && !video.filename) {
      video.filename = basenameFromUrl(video.url || video.proxyURL || video.proxy_url) || embed.title || 'video';
    }
    if (!video.thumbnail && (embed.thumbnail || embed.image)) {
      video.thumbnail = embed.thumbnail || embed.image;
    }
    add(video, false);
  }

  return out;
}

function withVideos(target, message, include) {
  if (!include || !target) return target;
  const list = collectVideos(message);
  if (list.length) target.videos = list;
  else delete target.videos;
  return target;
}

function inferAudioType(filename, url) {
  const s = `${filename || ''} ${url || ''}`.toLowerCase();
  if (/\.(?:wav|wave)(?:$|[?#])/u.test(s)) return 'audio/wav';
  if (/\.mp3(?:$|[?#])/u.test(s)) return 'audio/mpeg';
  if (/\.(?:ogg|oga|opus)(?:$|[?#])/u.test(s)) return 'audio/ogg';
  if (/\.m4a(?:$|[?#])/u.test(s)) return 'audio/mp4';
  if (/\.flac(?:$|[?#])/u.test(s)) return 'audio/flac';
  if (/\.aac(?:$|[?#])/u.test(s)) return 'audio/aac';
  return '';
}

function normalizeAudioType(value, filename, url) {
  const base = normalizeType(value);
  if (base === 'audio/x-wav' || base === 'audio/wave' || base === 'audio/vnd.wave') return 'audio/wav';
  if (base === 'audio/mp3') return 'audio/mpeg';
  if (base === 'audio/x-m4a' || base === 'audio/m4a') return 'audio/mp4';
  if (base.startsWith('audio/')) return base;
  return inferAudioType(filename, url);
}

function kindFromType(type, filename, url) {
  const t = normalizeType(type) || inferType(filename, url) || inferVideoType(filename, url) || inferAudioType(filename, url);
  if (t && t.startsWith('video/')) return 'video';
  if (t && t.startsWith('image/')) return 'image';
  if (t && t.startsWith('audio/')) return 'audio';
  if (inferVideoType(filename, url)) return 'video';
  if (inferType(filename, url)) return 'image';
  if (inferAudioType(filename, url)) return 'audio';
  return 'file';
}

/**
 * Metadata-only list of attachments, video/gifv embeds and stickers.
 * No URLs — safe to include even when media is not forwarded.
 */
function attachmentsSummary(message) {
  if (!message) return [];
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || out.length >= 8) return;
    const key = `${item.kind}:${item.filename}:${item.size || 0}:${item.content_type || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const attachment of asList(message.attachments)) {
    if (!attachment || typeof attachment !== 'object') continue;
    const filename = attachment.name || attachment.filename || basenameFromUrl(attachment.url || attachment.proxyURL || '') || 'fichier';
    const contentType = normalizeType(attachment.contentType || attachment.content_type)
      || inferType(filename, attachment.url)
      || inferVideoType(filename, attachment.url)
      || null;
    const size = numOrNull(attachment.size);
    const kind = kindFromType(contentType, filename, attachment.url);
    const tooLarge = kind === 'video' && size !== null && size > VIDEO_MAX_BYTES;
    const item = {
      kind,
      filename,
      content_type: contentType,
      width: numOrNull(attachment.width),
      height: numOrNull(attachment.height),
      size,
      duration: numOrNull(attachment.duration ?? attachment.duration_secs ?? attachment.durationSecs),
    };
    if (tooLarge) item.skip_reason = 'too_large';
    push(item);
  }

  for (const embed of asList(message.embeds)) {
    if (!embed || typeof embed !== 'object') continue;
    const typ = String(embed.type || '').toLowerCase();
    if (embed.video || typ === 'gifv' || typ === 'video') {
      const video = embed.video || {};
      const filename = basenameFromUrl(video.url || video.proxyURL || video.proxy_url || '') || embed.title || 'video';
      push({
        kind: 'video',
        filename,
        content_type: normalizeVideoType(video.contentType || video.content_type, filename, video.url) || inferVideoType(filename, video.url) || null,
        width: numOrNull(video.width),
        height: numOrNull(video.height),
        size: numOrNull(video.size),
        duration: numOrNull(video.duration ?? video.duration_secs),
      });
      continue;
    }
    const img = embed.image || embed.thumbnail;
    if (img && (img.url || img.proxyURL || img.proxy_url)) {
      const filename = basenameFromUrl(img.url || img.proxyURL || img.proxy_url) || 'image';
      push({
        kind: 'image',
        filename,
        content_type: inferType(filename, img.url) || null,
        width: numOrNull(img.width),
        height: numOrNull(img.height),
        size: null,
        duration: null,
      });
    }
  }

  for (const sticker of asList(message.stickers || message.stickerItems || message.sticker_items)) {
    if (!sticker || typeof sticker !== 'object') continue;
    push({
      kind: 'sticker',
      filename: sticker.name || sticker.id || 'sticker',
      content_type: null,
      width: numOrNull(sticker.width),
      height: numOrNull(sticker.height),
      size: null,
      duration: null,
    });
  }

  return out;
}

function describeSummary(summary) {
  if (!Array.isArray(summary) || !summary.length) return '';
  const parts = summary.map((s) => {
    const name = s.filename || s.kind;
    if (s.kind === 'video') {
      const bits = [name];
      if (s.duration != null) bits.push(`${s.duration}s`);
      if (s.skip_reason === 'too_large') bits.push('trop lourde, exclue');
      return `vidéo: ${bits.join(', ')}`;
    }
    if (s.kind === 'image') return `image: ${name}`;
    if (s.kind === 'audio') {
      const bits = [name];
      if (s.duration != null) bits.push(`${s.duration}s`);
      return `audio: ${bits.join(', ')}`;
    }
    if (s.kind === 'sticker') return `sticker: ${name}`;
    return `fichier: ${name}`;
  });
  return `[${parts.join(' ; ')}]`;
}

/** If the text is empty, replace it with a short media annotation so the payload is not "blank". */
function annotateEmptyContent(content, message) {
  const text = String(content || '');
  if (text.trim()) return text;
  return describeSummary(attachmentsSummary(message)) || text;
}

const FILE_MAX_COUNT = 8;
const FILE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Every real attachment, with a URL, for humans and bots alike.
 * Unlike images/videos, this is not gated on "aimed at the bot".
 */
function toFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.proxyURL || raw.proxy_url || null;
  if (!url || typeof url !== 'string') return null;
  const filename = raw.name || raw.filename || basenameFromUrl(url) || 'fichier';
  const contentType = normalizeType(raw.contentType || raw.content_type)
    || inferType(filename, url)
    || inferVideoType(filename, url)
    || inferAudioType(filename, url)
    || null;
  const size = numOrNull(raw.size);
  const duration = numOrNull(raw.duration ?? raw.duration_secs ?? raw.durationSecs);
  const proxy = raw.proxyURL || raw.proxy_url || null;
  const kind = kindFromType(contentType, filename, url);
  const item = {
    url,
    filename,
    content_type: contentType,
    size,
    duration,
    kind,
    id: raw.id != null && raw.id !== '' ? String(raw.id) : null,
    proxy_url: proxy && proxy !== url ? proxy : (proxy || null),
  };
  if (size != null && size > FILE_MAX_BYTES) item.skip_reason = 'too_large';
  return item;
}

function collectFiles(message) {
  if (!message) return [];
  const out = [];
  const seen = new Set();
  for (const attachment of asList(message.attachments)) {
    if (out.length >= FILE_MAX_COUNT) break;
    const item = toFile(attachment);
    if (!item) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    out.push(item);
  }
  return out;
}

function withFiles(target, message) {
  if (!target) return target;
  const list = collectFiles(message);
  if (list.length) target.files = list;
  else delete target.files;
  const summary = attachmentsSummary(message);
  if (summary.length) target.attachments_summary = summary;
  else delete target.attachments_summary;
  return target;
}

function withMedia(target, message, include) {
  if (!target) return target;
  withFiles(target, message);
  if (include) {
    withImages(target, message, true);
    withVideos(target, message, true);
  }
  return target;
}

module.exports = {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_COUNT,
  PREVIEW_MAX_EDGE,
  previewUrl,
  VIDEO_MAX_BYTES,
  VIDEO_MAX_COUNT,
  FILE_MAX_COUNT,
  FILE_MAX_BYTES,
  collectImages,
  collectVideos,
  collectFiles,
  shouldAttachImages,
  shouldAttachMedia: shouldAttachImages,
  withImages,
  withVideos,
  withFiles,
  withMedia,
  attachmentsSummary,
  annotateEmptyContent,
  describeSummary,
};
