'use strict';

/**
 * Pure helpers for auto-voice decisions, especially when a user moves or
 * kicks the bot. Kept free of discord.js so the cases are unit-tested.
 */

const DEFAULT_RETURN_MS = 1_000;

const DEFAULT_LEAVE_RETURN_MS = 400;

const MIN_RETURN_MS = 250;
const MAX_RETURN_MS = 2_000;
const BOT_COMMAND_WINDOW_MS = 15_000;

function parseReturnMs(raw, fallback = DEFAULT_RETURN_MS) {
  const n = Number(raw != null && raw !== '' ? raw : fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RETURN_MS, Math.max(MIN_RETURN_MS, Math.floor(n)));
}

/**
 * True when the bot just sent a join/move/leave, so the resulting
 * voiceStateUpdate (including a brief channel_id=null from a rejoin) is ours.
 */
function isRecentBotVoiceCommand(lastSent, newChannelId, now, windowMs = BOT_COMMAND_WINDOW_MS) {
  if (!lastSent || lastSent.at == null) return false;
  const ts = Number(lastSent.at);
  if (!Number.isFinite(ts) || now - ts >= windowMs) return false;
  if (lastSent.channelId === newChannelId) return true;
  if (newChannelId == null && lastSent.channelId) return true;
  return false;
}

/**
 * Decide what to do when the bot's own voice channel changes.
 *
 * - ignore: we caused it, or it is not a displacement.
 * - defer: let the regular debounced auto-voice path run (leave if every
 *   channel is empty; hysteresis if the destination still has humans).
 * - return: move/rejoin the busiest human channel promptly, without leaving.
 */
function decideForcedBotVoice({
  initiatedByBot,
  destChannelId,
  destHumans,
  targetId,
  targetHumans,
} = {}) {
  if (initiatedByBot) return { action: 'ignore' };
  if (!targetId || !(Number(targetHumans) > 0)) return { action: 'defer' };
  if (destChannelId && destChannelId === targetId) return { action: 'defer' };
  if (destChannelId && (Number(destHumans) || 0) > 0) return { action: 'defer' };
  return {
    action: 'return',
    reason: destChannelId ? 'forced-move' : 'forced-disconnect',
    targetId,
  };
}


/**
 * After a human (or a greeted bot) leaves or switches out of the bot's
 * channel, or after the greet queue goes idle, decide whether to return
 * promptly to the busiest human channel without leaving voice.
 *
 * - hold: a greet is still playing or queued; wait until the queue is idle.
 * - ignore: already in the busiest channel, or tied for it.
 * - defer: let the regular debounced path run (leave if every channel is
 *   empty; or move later if people are still in this channel after a greet).
 * - return: move to the busiest channel now.
 */
function decideAfterUserLeave({
  botChannelId,
  currentHumans,
  targetId,
  targetHumans,
  greetHoldChannelId,
  trigger = 'leave',
} = {}) {
  if (greetHoldChannelId) {
    return { action: 'hold', reason: 'greet-pending' };
  }
  if (!targetId || !(Number(targetHumans) > 0)) {
    return { action: 'defer', reason: 'all-empty' };
  }
  if (botChannelId && botChannelId === targetId) {
    return { action: 'ignore', reason: 'already-busiest' };
  }
  // After a greet, if someone is still here, keep the existing 5 s debounce
  // instead of leaving them immediately. A leave (or a queue that drained
  // because they left before / during the clip) returns right away.
  if (trigger === 'idle' && (Number(currentHumans) || 0) > 0) {
    return { action: 'defer', reason: 'still-occupied' };
  }
  return {
    action: 'return',
    reason: trigger === 'idle' ? 'greet-idle' : 'after-leave',
    targetId,
  };
}

module.exports = {
  DEFAULT_RETURN_MS,
  DEFAULT_LEAVE_RETURN_MS,
  MIN_RETURN_MS,
  MAX_RETURN_MS,
  BOT_COMMAND_WINDOW_MS,
  parseReturnMs,
  isRecentBotVoiceCommand,
  decideForcedBotVoice,
  decideAfterUserLeave,
};
