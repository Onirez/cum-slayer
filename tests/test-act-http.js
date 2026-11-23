'use strict';
// Offline tests for the optional /act HTTP API. No Discord, no Fly.
process.env.ACT_HTTP = 'on';
process.env.ACT_SHARED_SECRET = 'test-secret-for-act-http-unit';
process.env.ACT_HTTP_HOST = '127.0.0.1';
process.env.PORT = '0'; // let the OS pick a port
delete process.env.ACT_REMOTE_URL; // never proxy during tests

const http = require('http');
const { start } = require('../src/act_http');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

function req(port, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* ignore */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  const server = start({ log: () => {}, getReady: () => true });
  if (!server) {
    console.log('FAIL server did not start');
    process.exit(1);
  }
  await new Promise((resolve) => server.on('listening', resolve));
  const port = server.address().port;

  const health = await req(port, { method: 'GET', path: '/health' });
  ok(health.status === 200 && health.json && health.json.ok === true && health.json.ready === true, 'GET /health no auth');

  const noAuth = await req(port, { method: 'POST', path: '/act', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(noAuth.status === 401, `POST /act without bearer is 401 (got ${noAuth.status})`);

  const bad = await req(port, {
    method: 'POST', path: '/act',
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
    body: '{}',
  });
  ok(bad.status === 401, `POST /act with wrong bearer is 401 (got ${bad.status})`);

  const dry = await req(port, {
    method: 'POST', path: '/act?dry_run=1',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret-for-act-http-unit' },
    body: JSON.stringify({
      channel_id: '1571542249051783228',
      message_id: null,
      reply: null,
      react: null,
      memory_append: [],
      skill_create: null,
    }),
  });
  ok(dry.status === 200 && dry.json && dry.json.ok === true, `POST /act dry-run ok (status=${dry.status} ok=${dry.json && dry.json.ok})`);
  ok(dry.json && /"ok":true/.test(dry.json.stdout || ''), 'dry-run stdout contains act.sh success JSON');
  ok(!(dry.raw || '').includes('test-secret-for-act-http-unit'), 'response does not echo the secret');

  const unknown = await req(port, {
    method: 'POST', path: '/run',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret-for-act-http-unit' },
    body: JSON.stringify({ tool: 'rm', args: ['-rf', '/'] }),
  });
  ok(unknown.status === 400, `POST /run rejects unknown tool (got ${unknown.status})`);

  server.close();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
