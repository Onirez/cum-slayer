'use strict';

/**
 * Optional authenticated HTTP surface for the routine (Fly cut-over).
 * Off unless ACT_HTTP is on/1/true. Never logs secrets, tokens, or
 * Authorization headers. Box mode is unchanged when the flag is off.
 *
 *   GET  /health  — no auth (Fly checks)
 *   POST /act     — Bearer ACT_SHARED_SECRET, raw JSON body = act.sh stdin
 *   POST /run     — Bearer, JSON { tool, args?, stdin? } for the other CLIs
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_TOOLS = Object.freeze({
  act: 'act.sh',
  memory: 'memory.sh',
  user: 'user.sh',
  skills: 'skills.sh',
  context: 'context.sh',
  dm: 'dm.sh',
  react: 'react.sh',
  send: 'send.sh',
  embed: 'embed.sh',
  mod: 'mod.sh',
  reply: 'reply.sh',
  roast_now: 'roast_now.sh',
});

const MAX_BODY = 48 * 1024 * 1024; // 4 images × 8 MiB, base64 + JSON
const RUN_TIMEOUT_MS = Number(process.env.ACT_HTTP_TIMEOUT_MS || 90_000);
const config = require('./config');
const DIR = config.SCRIPTS_DIR;

function flagOn(name, fallback = 'off') {
  return !['0', 'false', 'no', 'off', ''].includes(
    String(process.env[name] ?? fallback).trim().toLowerCase(),
  );
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    const dummy = Buffer.alloc(32);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function authorize(req) {
  const secret = process.env.ACT_SHARED_SECRET || '';
  if (!secret) return false;
  const hdr = String(req.headers.authorization || '');
  return timingSafeEqualStr(hdr, `Bearer ${secret}`);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

let runChain = Promise.resolve();
function enqueue(fn) {
  const run = runChain.then(fn, fn);
  runChain = run.catch(() => {});
  return run;
}

function runTool(tool, args, stdin, extraEnv) {
  const script = ALLOWED_TOOLS[tool];
  if (!script) {
    const err = new Error(`unknown tool: ${tool}`);
    err.code = 'UNKNOWN_TOOL';
    return Promise.reject(err);
  }
  const safeArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  return new Promise((resolve) => {
    const child = spawn(path.join(DIR, script), safeArgs, {
      cwd: config.ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => {
      child.killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3_000);
    }, RUN_TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: status == null ? 1 : status,
        signal: signal || null,
        timedOut: Boolean(child.killed && status !== 0),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        status: 1,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: e.message || String(e),
      });
    });
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function start({ log = console.log, getReady = () => true } = {}) {
  if (!flagOn('ACT_HTTP')) return null;
  const port = Number(process.env.PORT || process.env.ACT_HTTP_PORT || 8080);
  const host = process.env.ACT_HTTP_HOST || '0.0.0.0';
  if (!process.env.ACT_SHARED_SECRET) {
    log('act-http warn: ACT_SHARED_SECRET is not set; /act and /run will return 503');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { ok: true, ready: Boolean(getReady()) });
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/act' || url.pathname === '/run')) {
        if (!process.env.ACT_SHARED_SECRET) {
          json(res, 503, { ok: false, error: 'act endpoint not configured' });
          return;
        }
        if (!authorize(req)) {
          json(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        let raw;
        try {
          raw = await readBody(req, MAX_BODY);
        } catch (e) {
          if (e.code === 'TOO_LARGE') {
            json(res, 413, { ok: false, error: 'payload too large' });
            return;
          }
          throw e;
        }
        const isAct = url.pathname === '/act';
        let tool = 'act';
        let args = [];
        let stdin = '';
        let dryRun = false;
        if (isAct) {
          stdin = raw.toString('utf8');
          const qDry = url.searchParams.get('dry_run') || url.searchParams.get('dry-run');
          if (qDry === '1' || qDry === 'true') dryRun = true;
        } else {
          let body;
          try {
            body = JSON.parse(raw.toString('utf8') || '{}');
          } catch {
            json(res, 400, { ok: false, error: 'invalid JSON' });
            return;
          }
          tool = String(body.tool || '').trim();
          args = Array.isArray(body.args) ? body.args : [];
          stdin = body.stdin == null ? '' : String(body.stdin);
          dryRun = Boolean(body.dry_run || body.dryRun);
        }
        if (!ALLOWED_TOOLS[tool]) {
          json(res, 400, { ok: false, error: 'unknown tool' });
          return;
        }
        const extraEnv = {};
        if (dryRun && !args.includes('--dry-run')) {
          if (tool === 'act') extraEnv.DRY_RUN = '1';
          else args = ['--dry-run', ...args];
        }
        log(`act-http ${isAct ? '/act' : '/run'} tool=${tool} dry=${dryRun ? 1 : 0} args=${args.length}`);
        const result = await enqueue(() => runTool(tool, args, stdin, extraEnv));
        const payload = {
          ok: result.status === 0 && !result.timedOut,
          status: result.status,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        // Preserve CLI stdout for the routine as the main text body too,
        // while keeping a structured trailer the wrappers can parse.
        res.writeHead(payload.ok ? 200 : 500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(payload));
        return;
      }
      json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      log(`act-http error: ${err && err.message ? err.message : err}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    }
  });

  server.listen(port, host, () => {
    log(`act-http listening on ${host}:${port}`);
  });
  server.on('error', (err) => {
    log(`act-http listen failed: ${err.message}`);
  });
  return server;
}

module.exports = { start, flagOn, authorize, runTool, ALLOWED_TOOLS, timingSafeEqualStr, MAX_BODY };
