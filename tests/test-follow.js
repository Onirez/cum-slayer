'use strict';

/**
 * Offline unit tests for FollowSessions (conversation-follow windows,
 * per-window cap, hourly cap, debounce). No Discord, no network.
 */

const path = require('path');
const assert = require('assert');

function src(file) {
  const root = path.join(__dirname, '..', 'src', file);
  const live = path.join(__dirname, '..', file);
  return require(require('fs').existsSync(root) ? root : live);
}

const { FollowSessions, fromEnv, DEFAULTS } = src('follow.js');

let failed = 0;
function check(cond, label) {
  if (cond) {
    console.log(`ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function harness(opts = {}) {
  let now = opts.start ?? 1_000_000;
  const timers = new Map();
  let tid = 0;
  const sessions = new FollowSessions({
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++tid;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    windowMs: opts.windowMs ?? 120_000,
    debounceMs: opts.debounceMs ?? 4_500,
    maxPerWindow: opts.maxPerWindow ?? 3,
    hourlyMax: opts.hourlyMax ?? 30,
    hourlyMs: opts.hourlyMs ?? 3_600_000,
    enabled: opts.enabled ?? true,
  });
  function advance(ms) {
    now += ms;
    const due = [...timers.entries()]
      .filter(([, t]) => t.at <= now)
      .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
    for (const [id, t] of due) {
      timers.delete(id);
      t.fn();
    }
  }
  return { sessions, advance, now: () => now, timers };
}

// --- defaults ---
check(DEFAULTS.windowMs === 120_000, 'default window is 2 minutes');
check(DEFAULTS.maxPerWindow === 3, 'default max 3 follows per window');
check(DEFAULTS.debounceMs === 4_500, 'default debounce is 4.5 s');
check(DEFAULTS.hourlyMax === 30, 'default hourly cap is 30');
check(DEFAULTS.hourlyMs === 3_600_000, 'default hourly window is 1 h');

// --- window open / close ---
{
  const { sessions, advance } = harness();
  check(sessions.canFollow('c1').reason === 'no_window', 'no follow before a bot reply');
  sessions.noteBotReply('c1');
  check(sessions.isOpen('c1') === true, 'window opens after a bot reply');
  check(sessions.canFollow('c1').ok === true, 'follow allowed while the window is open');
  advance(119_999);
  check(sessions.isOpen('c1') === true, 'window still open just before expiry');
  advance(2);
  check(sessions.isOpen('c1') === false, 'window closed after 2 minutes');
  check(sessions.canFollow('c1').reason === 'no_window', 'follow refused after expiry');
}

// --- refresh does not reset count ---
{
  const { sessions, advance } = harness();
  sessions.noteBotReply('c1');
  sessions.recordFollow('c1');
  sessions.recordFollow('c1');
  check(sessions.count('c1') === 2, 'two follows recorded');
  advance(60_000);
  sessions.noteBotReply('c1');
  check(sessions.count('c1') === 2, 'bot reply refreshes the window but does not reset the count');
  advance(119_000);
  check(sessions.isOpen('c1') === true, 'refreshed window still open almost 2 min later');
  check(sessions.canFollow('c1').ok === true, 'third follow still allowed after refresh');
  sessions.recordFollow('c1');
  check(sessions.canFollow('c1').reason === 'max_per_window', 'fourth follow blocked (cap 3)');
}

// --- real human trigger resets the count ---
{
  const { sessions } = harness();
  sessions.noteBotReply('c1');
  sessions.recordFollow('c1');
  sessions.recordFollow('c1');
  sessions.recordFollow('c1');
  check(sessions.canFollow('c1').reason === 'max_per_window', 'capped before reset');
  sessions.noteRealTrigger('c1');
  check(sessions.count('c1') === 0, 'real human trigger resets the per-window count');
  check(sessions.isOpen('c1') === true, 'reset does not close the existing window');
  check(sessions.canFollow('c1').ok === true, 'follow allowed again after a real trigger');
}

// --- hourly cap is global ---
{
  const { sessions, advance } = harness({ hourlyMax: 3, hourlyMs: 3_600_000 });
  sessions.noteBotReply('c1');
  sessions.noteBotReply('c2');
  sessions.recordFollow('c1');
  sessions.recordFollow('c2');
  sessions.recordFollow('c1');
  check(sessions.canFollow('c1').reason === 'hourly_cap', 'hourly cap blocks even with per-window room');
  check(sessions.canFollow('c2').reason === 'hourly_cap', 'hourly cap is global, not per channel');
  advance(3_600_000);
  sessions.noteBotReply('c1');
  check(sessions.canFollow('c1').ok === true, 'hourly cap slides off after 1 h');
}

// --- debounce coalesces same user ---
{
  const { sessions, advance } = harness();
  const fired = [];
  sessions.noteBotReply('c1');
  const s1 = sessions.schedule({
    channelId: 'c1', userId: 'u1', message: { id: 'm1' },
    onFire: (m) => fired.push(m.id),
  });
  check(s1.reason === 'scheduled', 'first message schedules a debounce');
  const s2 = sessions.schedule({
    channelId: 'c1', userId: 'u1', message: { id: 'm2' },
    onFire: (m) => fired.push(m.id),
  });
  check(s2.reason === 'debounced', 'second rapid message from the same user replaces the pending one');
  advance(4_499);
  check(fired.length === 0, 'debounce has not fired yet at 4499 ms');
  advance(1);
  check(fired.join(',') === 'm2', 'one fire, with the latest message as target');
  check(sessions.count('c1') === 1, 'debounce counts as a single follow');
}

// --- window expiry during debounce skips and does not count ---
{
  const { sessions, advance } = harness({ windowMs: 5_000, debounceMs: 4_500 });
  const fired = [];
  const skipped = [];
  sessions.noteBotReply('c1');
  advance(1_000);
  sessions.schedule({
    channelId: 'c1', userId: 'u1', message: { id: 'm1' },
    onFire: (m) => fired.push(m.id),
    onSkip: (reason) => skipped.push(reason),
  });
  advance(4_500);
  check(fired.length === 0, 'expired window does not fire');
  check(skipped.join(',') === 'no_window', 'skip reason is no_window');
  check(sessions.count('c1') === 0, 'expired debounce does not increment the cap');
}

// --- two users can both fire, still capped at 3 ---
{
  const { sessions, advance } = harness();
  const fired = [];
  sessions.noteBotReply('c1');
  sessions.schedule({ channelId: 'c1', userId: 'u1', message: { id: 'a' }, onFire: (m) => fired.push(m.id) });
  sessions.schedule({ channelId: 'c1', userId: 'u2', message: { id: 'b' }, onFire: (m) => fired.push(m.id) });
  sessions.schedule({ channelId: 'c1', userId: 'u3', message: { id: 'c' }, onFire: (m) => fired.push(m.id) });
  sessions.schedule({ channelId: 'c1', userId: 'u4', message: { id: 'd' }, onFire: (m) => fired.push(m.id) });
  advance(4_500);
  fired.sort();
  check(fired.join(',') === 'a,b,c', 'first three users fire, the fourth is dropped at fire time');
  check(sessions.count('c1') === 3, 'cap stays at 3');
}

// --- real trigger cancels pending debounce ---
{
  const { sessions, advance } = harness();
  const fired = [];
  sessions.noteBotReply('c1');
  sessions.schedule({ channelId: 'c1', userId: 'u1', message: { id: 'm1' }, onFire: (m) => fired.push(m.id) });
  sessions.noteRealTrigger('c1');
  advance(4_500);
  check(fired.length === 0, 'pending follow is cancelled when a real human trigger arrives');
}

// --- disabled ---
{
  const { sessions } = harness({ enabled: false });
  sessions.noteBotReply('c1');
  check(sessions.canFollow('c1').reason === 'disabled', 'FOLLOW=off refuses follow even with a window');
}

// --- fromEnv defaults and FOLLOW=off ---
{
  const prev = { ...process.env };
  delete process.env.FOLLOW;
  delete process.env.FOLLOW_WINDOW_MS;
  const a = fromEnv();
  check(a.enabled === true && a.windowMs === 120_000 && a.maxPerWindow === 3, 'fromEnv uses documented defaults');
  process.env.FOLLOW = 'off';
  process.env.FOLLOW_WINDOW_MS = '60000';
  process.env.FOLLOW_MAX_PER_WINDOW = '2';
  process.env.FOLLOW_DEBOUNCE_MS = '5000';
  process.env.FOLLOW_HOURLY_MAX = '10';
  const b = fromEnv();
  check(b.enabled === false && b.windowMs === 60_000 && b.maxPerWindow === 2 && b.debounceMs === 5_000 && b.hourlyMax === 10, 'fromEnv reads FOLLOW_* env');
  process.env.FOLLOW = prev.FOLLOW;
  process.env.FOLLOW_WINDOW_MS = prev.FOLLOW_WINDOW_MS;
  process.env.FOLLOW_MAX_PER_WINDOW = prev.FOLLOW_MAX_PER_WINDOW;
  process.env.FOLLOW_DEBOUNCE_MS = prev.FOLLOW_DEBOUNCE_MS;
  process.env.FOLLOW_HOURLY_MAX = prev.FOLLOW_HOURLY_MAX;
  if (prev.FOLLOW === undefined) delete process.env.FOLLOW;
  if (prev.FOLLOW_WINDOW_MS === undefined) delete process.env.FOLLOW_WINDOW_MS;
  if (prev.FOLLOW_MAX_PER_WINDOW === undefined) delete process.env.FOLLOW_MAX_PER_WINDOW;
  if (prev.FOLLOW_DEBOUNCE_MS === undefined) delete process.env.FOLLOW_DEBOUNCE_MS;
  if (prev.FOLLOW_HOURLY_MAX === undefined) delete process.env.FOLLOW_HOURLY_MAX;
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nAll follow tests passed.');
