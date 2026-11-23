#!/usr/bin/env node
'use strict';
// CLI guard for shell scripts (Discord Agent Rules, see AGENTS.md).
//   guard.js speak <channel_id> [message_id]   -> exit 0 if the bot may post there
//   guard.js dm <user_id>                      -> exit 0 if the user interacted before
const scope = require('./scope');
(async () => {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === 'speak' && a) {
    if (b && scope.triggerRecord(b)) return;
    await scope.assertMaySpeakIn(a);
    return;
  }
  if (mode === 'dm' && a) {
    if (!scope.hasInteracted(a)) throw new Error('refused: no prior interaction with this user (DM rule, see AGENTS.md)');
    return;
  }
  console.error('Usage: guard.js speak <channel_id> [message_id] | guard.js dm <user_id>');
  process.exit(2);
})().catch((e) => { console.error(`error: ${e && e.message ? e.message : e}`); process.exit(3); });
