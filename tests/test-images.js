'use strict';
// Offline tests for image payload collection and img.sh URL guards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const images = fs.existsSync(path.join(root, 'images.js'))
  ? require('../images')
  : require('../src/images');
const scope = fs.existsSync(path.join(root, 'scope.js'))
  ? require('../scope')
  : require('../src/scope');
const { collectImages, shouldAttachImages, IMAGE_MAX_COUNT, IMAGE_MAX_BYTES, previewUrl } = images;

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const PNG = {
  url: 'https://cdn.discordapp.com/attachments/1/2/cat.png',
  name: 'cat.png',
  contentType: 'image/png',
  width: 64,
  height: 48,
  size: 1234,
};

function fields(img) {
  return img && ['url', 'filename', 'content_type', 'width', 'height', 'size'].every((k) => Object.prototype.hasOwnProperty.call(img, k));
}

// --- collectImages: attachments ---
const fromMap = collectImages({ attachments: new Map([['a', PNG]]) });
ok(fromMap.length === 1 && fromMap[0].url === PNG.url, 'collects a Map attachment');
ok(fields(fromMap[0]), 'attachment entry has url, filename, content_type, width, height, size');
ok(fromMap[0].filename === 'cat.png' && fromMap[0].content_type === 'image/png', 'maps name → filename and contentType → content_type');
ok(fromMap[0].width === 64 && fromMap[0].height === 48 && fromMap[0].size === 1234, 'keeps width, height, size');

ok(collectImages({ attachments: [PNG] }).length === 1, 'collects an array attachment');
ok(collectImages({ attachments: { id1: PNG } }).length === 1, 'collects a plain-object attachment collection');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/photo.jpg', name: 'photo.jpg', content_type: 'image/jpeg', size: 10, width: 1, height: 1, proxy_url: 'https://media.discordapp.net/a/photo.jpg' }],
}).length === 1, 'accepts snake_case content_type and prefers url over proxy_url');

ok(collectImages({
  attachments: [{ proxyURL: 'https://media.discordapp.net/a/photo.webp', name: 'photo.webp', contentType: 'image/webp', size: 10, width: 2, height: 2 }],
})[0].url === 'https://media.discordapp.net/a/photo.webp', 'falls back to proxyURL when url is missing');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/x.jpg', name: 'x.jpg', contentType: 'image/jpg', size: 8, width: 1, height: 1 }],
})[0].content_type === 'image/jpeg', 'normalizes image/jpg to image/jpeg');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/x.png', name: 'x.png', contentType: 'image/png; charset=binary', size: 8, width: 1, height: 1 }],
})[0].content_type === 'image/png', 'strips content-type parameters');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/no-type.png', name: 'no-type.png', size: 8, width: 1, height: 1 }],
}).length === 1, 'infers image/png from the filename when contentType is missing');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/notes.pdf', name: 'notes.pdf', contentType: 'application/pdf', size: 8 }],
}).length === 0, 'skips non-image attachments');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/icon.svg', name: 'icon.svg', contentType: 'image/svg+xml', size: 8 }],
}).length === 0, 'skips image/svg+xml');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/huge.png', name: 'huge.png', contentType: 'image/png', size: IMAGE_MAX_BYTES + 1, width: 10, height: 10 }],
}).length === 0, 'skips attachments over 10 MB');

ok(collectImages({
  attachments: [{ url: 'https://cdn.discordapp.com/a/ok.png', name: 'ok.png', contentType: 'image/png', size: IMAGE_MAX_BYTES, width: 10, height: 10 }],
}).length === 1, 'keeps an attachment of exactly 10 MB');

ok(collectImages({
  attachments: [{ name: 'missing.png', contentType: 'image/png', size: 8 }],
}).length === 0, 'skips attachments without a url or proxyURL');

// --- embeds ---
const embedImg = collectImages({
  embeds: [{ image: { url: 'https://cdn.discordapp.com/embeds/a.png', width: 100, height: 80 } }],
});
ok(embedImg.length === 1 && embedImg[0].filename === 'a.png' && embedImg[0].content_type === 'image/png', 'collects an embed.image and infers filename + type from the url');

const thumb = collectImages({
  embeds: [{ thumbnail: { url: 'https://cdn.discordapp.com/embeds/t.webp', proxyURL: 'https://media.discordapp.net/embeds/t.webp', width: 32, height: 32 } }],
});
ok(thumb.length === 1 && thumb[0].url === 'https://cdn.discordapp.com/embeds/t.webp', 'collects an embed.thumbnail and prefers url');

const both = collectImages({
  embeds: [{
    image: { url: 'https://cdn.discordapp.com/embeds/full.png', width: 200, height: 200 },
    thumbnail: { url: 'https://cdn.discordapp.com/embeds/thumb.png', width: 32, height: 32 },
  }],
});
ok(both.length === 2, 'keeps both embed image and thumbnail when URLs differ');

ok(collectImages({
  embeds: [{
    image: { url: 'https://cdn.discordapp.com/embeds/same.png' },
    thumbnail: { url: 'https://cdn.discordapp.com/embeds/same.png' },
  }],
}).length === 1, 'dedupes embed image and thumbnail that share a url');

ok(collectImages({
  attachments: [PNG],
  embeds: [{ image: { url: PNG.url } }],
}).length === 1, 'dedupes an attachment also present as an embed image');

ok(collectImages({
  attachments: [
    { url: 'https://cdn.discordapp.com/a/1.png', name: '1.png', contentType: 'image/png', size: 1, width: 1, height: 1 },
    { url: 'https://cdn.discordapp.com/a/2.jpg', name: '2.jpg', contentType: 'image/jpeg', size: 1, width: 1, height: 1 },
    { url: 'https://cdn.discordapp.com/a/3.webp', name: '3.webp', contentType: 'image/webp', size: 1, width: 1, height: 1 },
    { url: 'https://cdn.discordapp.com/a/4.gif', name: '4.gif', contentType: 'image/gif', size: 1, width: 1, height: 1 },
    { url: 'https://cdn.discordapp.com/a/5.png', name: '5.png', contentType: 'image/png', size: 1, width: 1, height: 1 },
  ],
}).length === IMAGE_MAX_COUNT, 'caps at 4 images');

ok(collectImages({ attachments: [], embeds: [] }).length === 0, 'empty message has no images');
ok(collectImages(null).length === 0, 'null message has no images');
ok(collectImages({}).length === 0, 'message without attachments or embeds has no images');

// --- previewUrl ---
const prev = previewUrl('https://cdn.discordapp.com/attachments/1/2/a.png?ex=abc&is=def&hm=fff');
ok(prev && prev.startsWith('https://media.discordapp.net/attachments/1/2/a.png'), 'previewUrl switches host to media.discordapp.net');
ok(prev.includes('format=jpeg') && !prev.includes('width=') && !prev.includes('height='), 'previewUrl asks for jpeg without width/height (no crop)');
ok(prev.includes('ex=abc') && prev.includes('hm=fff'), 'previewUrl keeps signed query params');
ok(previewUrl('https://evil.example/a.png') === null, 'previewUrl rejects a non-Discord host');
ok(previewUrl('http://cdn.discordapp.com/a.png') === null, 'previewUrl rejects http');
ok(previewUrl('https://user:pass@cdn.discordapp.com/a.png') === null, 'previewUrl rejects userinfo');

const collected = collectImages({ attachments: [PNG] });
ok(collected[0] && collected[0].preview_url, 'collectImages adds preview_url');
ok(collected[0].preview_url.includes('media.discordapp.net'), 'preview_url uses the media proxy');

// --- shouldAttachImages ---
ok(shouldAttachImages({ mentioned: true }) === true, 'include images when the bot is mentioned');
ok(shouldAttachImages({ named: true }) === true, 'include images when the bot is named');
ok(shouldAttachImages({ replyToBot: true }) === true, 'include images when the message replies to the bot');
ok(shouldAttachImages({ isDm: true }) === true, 'include images in a DM (directed at the bot)');
ok(shouldAttachImages({ mentioned: true, authorIsBot: true }) === false, 'never include images from other bots, even with a mention');
ok(shouldAttachImages({ replyToBot: true, authorIsBot: true }) === false, 'never include images from other bots, even as a reply');
ok(shouldAttachImages({ isDm: true, authorIsBot: true }) === false, 'never include images from other bots in DMs');
ok(shouldAttachImages({}) === false, 'omit images for ambient triggers (no mention, name, reply, or DM)');
ok(shouldAttachImages({ mentioned: false, named: false, replyToBot: false, isDm: false }) === false, 'keyword-only / ambient: no images');

ok(shouldAttachImages({ follow: true }) === true, 'include images on a human conversation-follow');
ok(shouldAttachImages({ follow: true, authorIsBot: true }) === false, 'never include images from other bots, even on follow');


// --- image-only messages still trigger when aimed at the bot ---
const d = scope.decideTrigger;
ok(d({ isDm: false, inAgents: false, explicitMention: false, mentioned: false, named: false, replyToBot: true, keyword: false }).trigger === 'reply_to_bot', 'image-only reply to the bot still triggers (empty content)');
ok(d({ isDm: false, inAgents: true, explicitMention: true, mentioned: true, named: false, replyToBot: false, keyword: false }).trigger === 'mention', 'image plus @mention still triggers');
ok(d({ isDm: true, inAgents: false, explicitMention: false, mentioned: false, named: false, replyToBot: false, keyword: false }).trigger === 'dm', 'image-only DM still triggers');
ok(d({ isDm: false, inAgents: true, explicitMention: false, mentioned: false, named: false, replyToBot: false, keyword: false }).trigger === null, 'image-only ambient message in AGENTS does not trigger');
ok(d({ isDm: false, inAgents: false, explicitMention: false, mentioned: false, named: false, replyToBot: false, keyword: false }).trigger === null, 'image-only message outside AGENTS with no mention/reply does not trigger');

// --- img.sh guards (no network) ---
const script = fs.existsSync(path.join(root, 'img.sh'))
  ? path.join(root, 'img.sh')
  : path.join(root, 'scripts', 'img.sh');
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'img-cache-'));
const runImg = (url, extraEnv = {}, extraArgs = []) => spawnSync('bash', [script, ...extraArgs, ...((url === undefined) ? [] : [url])], {
  encoding: 'utf8',
  env: { ...process.env, IMG_CACHE_DIR: tmpCache, IMG_CACHE_GC_MIN: '0', ...extraEnv },
});

const noArg = runImg();
ok(noArg.status === 2 && /Usage:/.test(noArg.stderr), 'img.sh without args exits 2 with usage');
const noAll = runImg(undefined, {}, ['--all']);
ok(noAll.status === 2 && /Usage:/.test(noAll.stderr), 'img.sh --all without urls exits 2 with usage');

const rejected = [
  ['http://cdn.discordapp.com/attachments/1/2/a.png', 'http (not https)'],
  ['https://evil.example/a.png', 'non-Discord host'],
  ['https://cdn.discordapp.com.evil.com/a.png', 'lookalike host'],
  ['https://user@cdn.discordapp.com/a.png', 'userinfo in URL'],
  ['https://cdn.discordapp.com:8443/a.png', 'non-443 port'],
  ['ftp://cdn.discordapp.com/a.png', 'non-https scheme'],
];
for (const [url, label] of rejected) {
  const r = runImg(url);
  ok(r.status !== 0 && /only https URLs/.test(r.stderr) && !r.stdout.includes('cdn.discordapp.com') && !r.stderr.includes(url), `img.sh rejects ${label} and does not print the url`);
}

// Local resize (no network): 2000x1500 PNG -> 1024x768 JPEG.
const helperDir = fs.existsSync(path.join(root, 'img_fetch.py')) ? root : path.join(root, 'scripts');
const resize = spawnSync('python3', [path.join(__dirname, 'test-img-resize.py'), helperDir], { encoding: 'utf8' });
ok(resize.status === 0 && /resize-ok 1024 768/.test(resize.stdout), `resizes a 2000x1500 png to 1024px jpeg (${((resize.stderr || resize.stdout || '').trim()).slice(0, 200)})`);

// Evict files older than 24 h, keep fresh ones.
const stale = path.join(tmpCache, 'stale.img');
const fresh = path.join(tmpCache, 'fresh.img');
fs.writeFileSync(stale, 'old');
fs.writeFileSync(fresh, 'new');
const ago = Date.now() - (25 * 60 * 60 * 1000);
fs.utimesSync(stale, ago / 1000, ago / 1000);
// Trigger cleanup via a rejected URL so we never hit the network.
runImg('https://example.com/nope.png');
ok(!fs.existsSync(stale) && fs.existsSync(fresh), 'img.sh deletes cache files older than 24 h and keeps fresh ones');

try { fs.rmSync(tmpCache, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
