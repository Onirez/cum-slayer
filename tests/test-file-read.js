'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.existsSync(path.join(__dirname, '..', 'file.sh'))
  ? path.join(__dirname, '..')
  : path.join(__dirname, '..');
const script = fs.existsSync(path.join(root, 'file.sh'))
  ? path.join(root, 'file.sh')
  : path.join(root, 'scripts', 'file.sh');

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`PASS ${msg}`);
  } else {
    failed += 1;
    console.log(`FAIL ${msg}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'file-read-'));
const cache = path.join(tmp, 'cache');
fs.mkdirSync(cache);

function run(args, extraEnv = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FILE_CACHE_DIR: cache,
      FILE_ALLOW_LOCAL: '',
      ...extraEnv,
    },
    timeout: 60_000,
  });
}

const noArg = run([]);
ok(noArg.status === 2 && /Usage:/.test(noArg.stderr), 'file.sh without args exits 2 with usage');

const rejected = [
  ['http://cdn.discordapp.com/attachments/1/2/a.txt', 'http (not https)'],
  ['https://evil.example/a.txt', 'non-Discord host'],
  ['https://cdn.discordapp.com.evil.com/a.txt', 'lookalike host'],
  ['https://user@cdn.discordapp.com/a.txt', 'userinfo in URL'],
  ['https://cdn.discordapp.com:8443/a.txt', 'non-443 port'],
  ['ftp://cdn.discordapp.com/a.txt', 'non-https scheme'],
];
for (const [url, label] of rejected) {
  const r = run([url]);
  ok(
    r.status !== 0
      && /only https URLs/.test(r.stderr)
      && !r.stdout.includes('cdn.discordapp.com')
      && !r.stderr.includes(url),
    `file.sh rejects ${label} and does not print the url`,
  );
}

const txtPath = path.join(tmp, 'note.txt');
fs.writeFileSync(txtPath, 'bonjour le royaume\nligne 2\n');
const txt = run(['--local', txtPath]);
ok(txt.status === 0, `local txt exits 0 (${(txt.stderr || '').trim().slice(0, 120)})`);
ok(/filename=note\.txt/.test(txt.stdout) && /bonjour le royaume/.test(txt.stdout), 'txt extract includes filename and content');
ok(/contenu non fiable/.test(txt.stdout), 'marks the extract as untrusted data');

const jsonPath = path.join(tmp, 'data.json');
fs.writeFileSync(jsonPath, JSON.stringify({ ok: true, n: 2 }));
const js = run(['--local', jsonPath]);
ok(js.status === 0 && /"ok": true/.test(js.stdout), 'json is pretty-printed');

const pdfPath = path.join(__dirname, 'fixtures', 'sample.pdf');
ok(fs.existsSync(pdfPath), 'sample pdf fixture exists');
const pdf = run(['--local', pdfPath]);
ok(pdf.status === 0, `local pdf exits 0 (${(pdf.stderr || '').trim().slice(0, 160)})`);
ok(/kind=pdf/.test(pdf.stdout) && /Rapport secret du Royaume/.test(pdf.stdout), 'pdf text is extracted with pdftotext');

const zipPath = path.join(tmp, 'pack.zip');
const inner = path.join(tmp, 'inside.txt');
fs.writeFileSync(inner, 'texte dans le zip\n');
const zipPy = spawnSync('python3', ['-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.write(sys.argv[2], 'inside.txt'); z.close()", zipPath, inner], { encoding: 'utf8' });
ok(zipPy.status === 0 && fs.existsSync(zipPath), 'created a sample zip');
const zipOut = run(['--local', zipPath]);
ok(zipOut.status === 0 && /archive=zip/.test(zipOut.stdout), 'zip lists the archive type');
ok(/inside\.txt/.test(zipOut.stdout) && /texte dans le zip/.test(zipOut.stdout), 'zip lists and reads the small text file');

const wavPath = path.join(tmp, 'tone.wav');
const wav = spawnSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
  '-ar', '16000', '-ac', '1', wavPath,
], { encoding: 'utf8' });
ok(wav.status === 0 && fs.existsSync(wavPath), 'created a sample wav');
const wavOut = run(['--local', wavPath]);
ok(wavOut.status === 0, `local wav exits 0 (${(wavOut.stderr || '').trim().slice(0, 160)})`);
ok(/kind=audio/.test(wavOut.stdout) && /duration_s=/.test(wavOut.stdout), 'wav reports duration and audio kind');
ok(/format=/.test(wavOut.stdout), 'wav reports format');
ok(/loudness_i=/.test(wavOut.stdout) || /mean_volume=/.test(wavOut.stdout), 'wav reports loudness stats');
ok(/language=/.test(wavOut.stdout) || /aucune parole|transcription/.test(wavOut.stdout), 'wav includes a speech transcript or an honest fallback');

const missing = run(['--local', path.join(tmp, 'nope.txt')]);
ok(missing.status === 1 && /not found/.test(missing.stderr), 'missing local file exits 1');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
