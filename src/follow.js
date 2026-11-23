'use strict';

/**
 * Conversation-follow sessions: after the bot posts in a guild channel, a
 * short window stays open so human messages without mention/alias/reply can
 * still be forwarded to the routine as trigger "follow".
 *
 * Pure in-memory state (cleared on restart). DMs, bots, and opt-out are
 * enforced by the caller; this module owns windows, caps, and debounce.
 */

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function flagOn(name, fallback = 'on') {
  return !['0', 'false', 'no', 'off', ''].includes(
    String(process.env[name] ?? fallback).trim().toLowerCase(),
  );
}

const DEFAULTS = {
  enabled: true,
  windowMs: 120_000,
  maxPerWindow: 3,
  debounceMs: 4_500,
  hourlyMax: 30,
  hourlyMs: 3_600_000,
};

class FollowSessions {
  constructor(opts = {}) {
    this.enabled = opts.enabled ?? DEFAULTS.enabled;
    this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
    this.maxPerWindow = opts.maxPerWindow ?? DEFAULTS.maxPerWindow;
    this.debounceMs = opts.debounceMs ?? DEFAULTS.debounceMs;
    this.hourlyMax = opts.hourlyMax ?? DEFAULTS.hourlyMax;
    this.hourlyMs = opts.hourlyMs ?? DEFAULTS.hourlyMs;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this._setTimeout = opts.setTimeout || setTimeout;
    this._clearTimeout = opts.clearTimeout || clearTimeout;
    this._channels = new Map(); // channelId -> { expiresAt, count }
    this._hourly = [];
    this._pending = new Map(); // `${channelId}:${userId}` -> { timer, message, channelId, userId }
  }

  _key(channelId, userId) {
    return `${channelId}:${userId}`;
  }

  _pruneHourly(now) {
    const cut = now - this.hourlyMs;
    while (this._hourly.length && this._hourly[0] <= cut) this._hourly.shift();
  }

  /** Open or refresh the follow window in this channel. Does not reset the per-window count. */
  noteBotReply(channelId, now = this._now()) {
    if (!channelId) return;
    const cur = this._channels.get(channelId) || { expiresAt: 0, count: 0 };
    cur.expiresAt = now + this.windowMs;
    this._channels.set(channelId, cur);
  }

  /**
   * A real human trigger (mention / alias / keyword / reply_to_bot) resets
   * the per-window count. Pending follow debounces in that channel are dropped.
   * The window itself is only extended when the bot actually replies.
   */
  noteRealTrigger(channelId, now = this._now()) {
    if (!channelId) return;
    const cur = this._channels.get(channelId);
    if (cur) {
      cur.count = 0;
      this._channels.set(channelId, cur);
    }
    this.cancelChannel(channelId);
  }

  isOpen(channelId, now = this._now()) {
    const cur = this._channels.get(channelId);
    return Boolean(cur && cur.expiresAt > now);
  }

  count(channelId) {
    return this._channels.get(channelId)?.count || 0;
  }

  canFollow(channelId, now = this._now()) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    const cur = this._channels.get(channelId);
    if (!cur || cur.expiresAt <= now) return { ok: false, reason: 'no_window' };
    if (cur.count >= this.maxPerWindow) return { ok: false, reason: 'max_per_window' };
    this._pruneHourly(now);
    if (this._hourly.length >= this.hourlyMax) return { ok: false, reason: 'hourly_cap' };
    return { ok: true };
  }

  recordFollow(channelId, now = this._now()) {
    const cur = this._channels.get(channelId) || { expiresAt: 0, count: 0 };
    cur.count += 1;
    this._channels.set(channelId, cur);
    this._hourly.push(now);
    this._pruneHourly(now);
  }

  cancel(channelId, userId) {
    const key = this._key(channelId, userId);
    const p = this._pending.get(key);
    if (!p) return;
    this._clearTimeout(p.timer);
    this._pending.delete(key);
  }

  cancelChannel(channelId) {
    for (const [key, p] of [...this._pending]) {
      if (p.channelId === channelId) {
        this._clearTimeout(p.timer);
        this._pending.delete(key);
      }
    }
  }

  /**
   * Debounce follow fire per channel+user. Rapid messages from the same
   * person collapse into one call of onFire(latestMessage).
   * onSkip(reason, message) is called if the window/caps fail at fire time.
   */
  schedule({ channelId, userId, message, onFire, onSkip, now }) {
    now = now ?? this._now();
    const check = this.canFollow(channelId, now);
    if (!check.ok) return { scheduled: false, reason: check.reason };
    const key = this._key(channelId, userId);
    const prev = this._pending.get(key);
    if (prev) this._clearTimeout(prev.timer);
    const run = () => {
      this._pending.delete(key);
      const t = this._now();
      const again = this.canFollow(channelId, t);
      if (!again.ok) {
        if (typeof onSkip === 'function') onSkip(again.reason, message);
        return;
      }
      this.recordFollow(channelId, t);
      if (typeof onFire === 'function') {
        Promise.resolve(onFire(message)).catch(() => {});
      }
    };
    const timer = this._setTimeout(run, this.debounceMs);
    this._pending.set(key, { timer, message, channelId, userId, onFire, onSkip });
    return { scheduled: true, reason: prev ? 'debounced' : 'scheduled' };
  }

  clear() {
    for (const p of this._pending.values()) this._clearTimeout(p.timer);
    this._pending.clear();
    this._channels.clear();
    this._hourly = [];
  }
}

function fromEnv(overrides = {}) {
  return new FollowSessions({
    enabled: flagOn('FOLLOW', 'on'),
    windowMs: envNum('FOLLOW_WINDOW_MS', DEFAULTS.windowMs),
    maxPerWindow: envNum('FOLLOW_MAX_PER_WINDOW', DEFAULTS.maxPerWindow),
    debounceMs: envNum('FOLLOW_DEBOUNCE_MS', DEFAULTS.debounceMs),
    hourlyMax: envNum('FOLLOW_HOURLY_MAX', DEFAULTS.hourlyMax),
    hourlyMs: envNum('FOLLOW_HOURLY_MS', DEFAULTS.hourlyMs),
    ...overrides,
  });
}

module.exports = { FollowSessions, fromEnv, DEFAULTS };
