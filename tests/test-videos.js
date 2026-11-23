'use strict';
// Offline tests for video payload collection, empty-content annotation, and vid.sh URL guards.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const images = fs.existsSync(path.join(root, 'images.js'))
  ? require('../images')
  : require('../src/images');

const {
  collectImages,
  collectVideos,
  shouldAttachImages,
  attachmentsSummary,
  annotateEmptyContent,
  VIDEO_MAX_COUNT,
  VIDEO_MAX_BYTES,
} = images;

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const MP4 = {
  url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
  proxyURL: 'https://media.discordapp.net/attachments/1/2/clip.mp4',
  name: 'clip.mp4',
  contentType: 'video/mp4',
  width: 1920,
  height: 1080,
  size: 4_000_000,
  duration: 6.5,
};

ok(collectImages({ attachments: [MP4] }).length === 0, 'collectImages still skips a video attachment (the gif/photo path stays unchanged)');

const fromMap = collectVideos({ attachments: new Map([['a', MP4]]) });
ok(fromMap.length === 1 && fromMap[0].url === MP4.url, 'collects a Map video attachment');
ok(fromMap[0].filename === 'clip.mp4' && fromMap[0].content_type === 'video/mp4', 'maps name and contentType');
ok(fromMap[0].width === 1920 && fromMap[0].height === 1080 && fromMap[0].size === 4_000_000, 'keeps width, height, size');
ok(fromMap[0].duration === 6.5, 'keeps duration');
ok(fromMap[0].proxy_url === MP4.proxyURL, 'keeps proxy_url when it differs from url');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/IMG_1.MOV', name: 'IMG_1.MOV', content_type: 'video/quicktime', size: 12_000, width: 1080, height: 1920 }],
})[0].content_type === 'video/quicktime', 'accepts iPhone video/quicktime (.MOV)');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/c.webm', name: 'c.webm', contentType: 'video/webm', size: 100, width: 10, height: 10 }],
}).length === 1, 'accepts video/webm');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/no-type.mp4', name: 'no-type.mp4', size: 100, width: 10, height: 10 }],
}).length === 1, 'infers video/mp4 from the filename when contentType is missing');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/x.m4v', name: 'x.m4v', contentType: 'video/x-m4v', size: 100 }],
})[0].content_type === 'video/mp4', 'normalizes video/x-m4v to video/mp4');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/notes.pdf', name: 'notes.pdf', contentType: 'application/pdf', size: 8 }],
}).length === 0, 'skips non-video attachments');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/pic.gif', name: 'pic.gif', contentType: 'image/gif', size: 8, width: 10, height: 10 }],
}).length === 0, 'skips image/gif (that stays on the images path — why a gif was visible but a video was not)');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/huge.mp4', name: 'huge.mp4', contentType: 'video/mp4', size: VIDEO_MAX_BYTES + 1, width: 10, height: 10 }],
}).length === 0, 'skips videos over 25 MB');

ok(collectVideos({
  attachments: [{ url: 'https://cdn.discordapp.com/a/ok.mp4', name: 'ok.mp4', contentType: 'video/mp4', size: VIDEO_MAX_BYTES, width: 10, height: 10 }],
}).length === 1, 'keeps a video of exactly 25 MB');

ok(collectVideos({
  attachments: [{ name: 'missing.mp4', contentType: 'video/mp4', size: 8 }],
}).length === 0, 'skips videos without a url or proxyURL');

// --- gifv / video embeds (Tenor, Giphy, Discord) ---
const tenor = collectVideos({
  embeds: [{
    type: 'gifv',
    title: 'dance',
    video: { url: 'https://media.tenor.com/abc/dance.mp4', width: 480, height: 480 },
    thumbnail: { url: 'https://media.tenor.com/abc/dance.gif', width: 480, height: 480 },
  }],
});
ok(tenor.length === 1 && tenor[0].url === 'https://media.tenor.com/abc/dance.mp4', 'collects a Tenor/gifv embed.video');
ok(tenor[0].thumbnail && tenor[0].thumbnail.url === 'https://media.tenor.com/abc/dance.gif', 'includes the gifv thumbnail as preview');
ok(tenor[0].content_type === 'video/mp4', 'infers mp4 from a gifv url');

ok(collectVideos({
  embeds: [{
    type: 'video',
    video: { url: 'https://media.giphy.com/media/xyz/giphy.mp4', proxy_url: 'https://media.giphy.com/media/xyz/giphy.mp4', width: 200, height: 200 },
  }],
}).length === 1, 'collects a Giphy video embed');

ok(collectVideos({
  attachments: [MP4],
  embeds: [{ type: 'gifv', video: { url: MP4.url } }],
}).length === 1, 'dedupes an attachment also present as an embed video');

ok(collectVideos({
  attachments: [
    { url: 'https://cdn.discordapp.com/a/1.mp4', name: '1.mp4', contentType: 'video/mp4', size: 1 },
    { url: 'https://cdn.discordapp.com/a/2.mp4', name: '2.mp4', contentType: 'video/mp4', size: 1 },
    { url: 'https://cdn.discordapp.com/a/3.mp4', name: '3.mp4', contentType: 'video/mp4', size: 1 },
  ],
}).length === VIDEO_MAX_COUNT, 'caps at 2 videos');

ok(collectVideos({ attachments: [], embeds: [] }).length === 0, 'empty message has no videos');
ok(collectVideos(null).length === 0, 'null message has no videos');

// same attach conditions as images
ok(shouldAttachImages({ replyToBot: true }) === true, 'videos ride the same attach conditions as images (reply)');
ok(shouldAttachImages({ follow: true }) === true, 'videos are included on a human follow');
ok(shouldAttachImages({ replyToBot: true, authorIsBot: true }) === false, 'videos are never included from other bots');

// --- attachments_summary + empty content ---
const videoOnly = { attachments: [MP4], content: '', embeds: [] };
const summary = attachmentsSummary(videoOnly);
ok(summary.length === 1 && summary[0].kind === 'video' && summary[0].filename === 'clip.mp4', 'attachments_summary lists the video without a url');
ok(!Object.prototype.hasOwnProperty.call(summary[0], 'url'), 'attachments_summary does not include a url');

const annotated = annotateEmptyContent('', videoOnly);
ok(annotated.includes('vidéo') && annotated.includes('clip.mp4'), 'empty content is annotated with the video filename');
ok(annotateEmptyContent('  ', videoOnly).includes('clip.mp4'), 'whitespace-only content is also annotated');
ok(annotateEmptyContent('regarde ça', videoOnly) === 'regarde ça', 'non-empty content is left unchanged');
ok(annotateEmptyContent('', { content: '', attachments: [] }) === '', 'a truly empty message stays empty');

const huge = attachmentsSummary({
  attachments: [{ url: 'https://cdn.discordapp.com/a/huge.mp4', name: 'huge.mp4', contentType: 'video/mp4', size: VIDEO_MAX_BYTES + 1 }],
});
ok(huge[0].skip_reason === 'too_large' && annotateEmptyContent('', { attachments: huge.length ? [{ name: 'huge.mp4', contentType: 'video/mp4', size: VIDEO_MAX_BYTES + 1 }] : [] }).includes('trop lourde'), 'oversized video is still described, marked too_large');

ok(attachmentsSummary({
  attachments: [{ url: 'https://cdn.discordapp.com/a/pic.gif', name: 'sowa.gif', contentType: 'image/gif', size: 40 }],
})[0].kind === 'image', 'a gif attachment is summarized as an image (that is why the gif was visible)');

ok(attachmentsSummary({
  stickers: [{ name: 'wave', id: '1' }],
})[0].kind === 'sticker', 'stickers appear in the summary so a sticker-only message is not blank');

// --- vid.sh guards (no network) ---
const script = fs.existsSync(path.join(root, 'vid.sh'))
  ? path.join(root, 'vid.sh')
  : path.join(root, 'scripts', 'vid.sh');
const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-cache-'));
const runVid = (url) => spawnSync('bash', [script, ...((url === undefined) ? [] : [url])], {
  encoding: 'utf8',
  env: { ...process.env, VID_CACHE_DIR: tmpCache },
});

const noArg = runVid();
ok(noArg.status === 2 && /Usage:/.test(noArg.stderr), 'vid.sh without args exits 2 with usage');

const rejected = [
  ['http://cdn.discordapp.com/attachments/1/2/a.mp4', 'http (not https)'],
  ['https://evil.example/a.mp4', 'non-allowed host'],
  ['https://cdn.discordapp.com.evil.com/a.mp4', 'lookalike host'],
  ['https://nottenor.com/a.mp4', 'suffix-trick tenor host'],
  ['https://user@cdn.discordapp.com/a.mp4', 'userinfo in URL'],
  ['https://cdn.discordapp.com:8443/a.mp4', 'non-443 port'],
  ['https://upload.wikimedia.org/a.mp4', 'wikimedia (not in allowlist)'],
];
for (const [url, label] of rejected) {
  const r = runVid(url);
  ok(r.status !== 0 && /only https URLs/.test(r.stderr) && !r.stdout.includes('cdn.discordapp.com') && !r.stderr.includes(url), `vid.sh rejects ${label} and does not print the url`);
}

const stale = path.join(tmpCache, 'stale.mp4');
const fresh = path.join(tmpCache, 'fresh.mp4');
fs.writeFileSync(stale, 'old');
fs.writeFileSync(fresh, 'new');
const ago = Date.now() - (25 * 60 * 60 * 1000);
fs.utimesSync(stale, ago / 1000, ago / 1000);
runVid('https://example.com/nope.mp4');
ok(!fs.existsSync(stale) && fs.existsSync(fresh), 'vid.sh deletes cache files older than 24 h and keeps fresh ones');

try { fs.rmSync(tmpCache, { recursive: true, force: true }); } catch { /* ignore */ }

// --- recent-style media: URLs must be visible for an earlier video in the channel ---
const recentVideo = images.withMedia({
  author: 'sowa',
  author_id: '1',
  message_id: '1574408763102732308',
  content: '',
}, {
  attachments: [{
    url: 'https://cdn.discordapp.com/attachments/1/1574408763102732308/Video-58441.mp4',
    name: 'Video-58441.mp4',
    contentType: 'video/mp4',
    size: 4_000_000,
    width: 1080,
    height: 1920,
  }],
}, true);
ok(recentVideo.videos && recentVideo.videos[0].url.includes('Video-58441.mp4'), 'withMedia on a recent item exposes the video URL');
ok(recentVideo.attachments_summary && recentVideo.attachments_summary[0].filename === 'Video-58441.mp4', 'recent item also carries attachments_summary');
ok(images.annotateEmptyContent('', {
  attachments: [{ name: 'Video-58441.mp4', contentType: 'video/mp4', size: 4_000_000 }],
}).includes('Video-58441.mp4'), 'empty content for that video is annotated with the filename');

// --- vid.sh local: silent video (no audio stream) ---
const vidScript = fs.existsSync(path.join(root, 'vid.sh'))
  ? path.join(root, 'vid.sh')
  : path.join(root, 'scripts', 'vid.sh');
const haveFfmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
if (haveFfmpeg) {
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-local-'));
  const silent = path.join(localDir, 'silent.mp4');
  const made = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:d=1',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
  ], { encoding: 'utf8' });
  if (made.status === 0 && fs.existsSync(silent)) {
    const localCache = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-lcache-'));
    const silentRun = spawnSync('bash', [vidScript, silent], {
      encoding: 'utf8',
      env: { ...process.env, VID_ALLOW_LOCAL: '1', VID_CACHE_DIR: localCache, VID_TOTAL_TIMEOUT: '28' },
    });
    ok(silentRun.status === 0 && /pas de piste audio/.test(silentRun.stdout), 'vid.sh on a video with no audio stream prints pas de piste audio');
    ok(!/transcript=/.test(silentRun.stdout), 'silent video does not invent a transcript');
    try { fs.rmSync(localCache, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    ok(true, 'skip local silent vid.sh (ffmpeg could not create a test clip)');
  }
  try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
} else {
  ok(true, 'skip local vid.sh tests (ffmpeg not installed)');
}


console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
