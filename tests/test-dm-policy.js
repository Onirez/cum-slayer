'use strict';
// Offline tests for inbound DM policy: any user who DMs the bot is recorded
// and a reply in that same DM is allowed. Unsolicited DMs stay refused.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scope = fs.existsSync(path.join(root, 'scope.js')) ? require('../scope') : require('../src/scope');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`PASS ${m}`); } else { fail++; console.log(`FAIL ${m}`); } };

const STRANGER = '999000111222333444';
const KNOWN = '111222333444555666';
const DM_CH = 'dm-channel-1';

ok(scope.decideTrigger({
  isDm: true, inAgents: false, explicitMention: false, mentioned: false,
  named: false, replyToBot: false, keyword: false,
}).trigger === 'dm', 'an inbound DM always decides trigger=dm, with no allowlist');

ok(scope.dmRecipientId({ type: 1, recipients: [{ id: STRANGER }] }) === STRANGER, 'recipient from recipients[0]');
ok(scope.dmRecipientId({ type: 1, recipient_id: STRANGER }) === STRANGER, 'recipient from recipient_id when the array is missing');
ok(scope.dmRecipientId({ type: 1, recipients: [] }) === null, 'no recipient if Discord omitted it');

ok(scope.dmReplyAllowed({ type: 1, recipients: [{ id: STRANGER }] }, DM_CH, {
  recentTriggerIn: () => false,
  hasInteracted: () => false,
  anyTriggerInChannel: () => false,
}) === null, 'a DM with no recorded contact is not a place we may start talking');

ok(scope.dmReplyAllowed({ type: 1, recipients: [{ id: STRANGER }] }, DM_CH, {
  recentTriggerIn: () => false,
  hasInteracted: (id) => id === STRANGER,
  anyTriggerInChannel: () => false,
}) === 'dm-interacted', 'after the user DMs us, hasInteracted allows the reply');

ok(scope.dmReplyAllowed({ type: 1, recipients: [] }, DM_CH, {
  recentTriggerIn: () => false,
  hasInteracted: () => false,
  anyTriggerInChannel: (id) => id === DM_CH,
}) === 'dm-channel-trigger', 'if recipients are missing, a recorded trigger in that DM still allows the reply');

ok(scope.dmReplyAllowed({ type: 1, recipients: [{ id: KNOWN }] }, 'other-dm', {
  recentTriggerIn: (id) => id === 'other-dm',
  hasInteracted: () => false,
  anyTriggerInChannel: () => false,
}) === 'recent-trigger', 'a recent trigger in the DM channel allows the reply');

(async () => {
  const allowed = await scope.assertMaySpeakIn(DM_CH, {
    recentTriggerIn: () => false,
    restInAgents: async () => ({ inAgents: false, channel: { id: DM_CH, type: 1, recipients: [{ id: STRANGER }] } }),
    hasInteracted: (id) => id === STRANGER,
    anyTriggerInChannel: () => false,
  });
  ok(allowed === 'dm-interacted', 'assertMaySpeakIn lets a reply through in the DM of someone who just wrote');

  let refused = false;
  try {
    await scope.assertMaySpeakIn(DM_CH, {
      recentTriggerIn: () => false,
      restInAgents: async () => ({ inAgents: false, channel: { id: DM_CH, type: 1, recipients: [{ id: STRANGER }] } }),
      hasInteracted: () => false,
      anyTriggerInChannel: () => false,
    });
  } catch (err) {
    refused = /no prior interaction/.test(err.message);
  }
  ok(refused, 'assertMaySpeakIn still refuses a DM with no inbound contact (no unsolicited DM)');

  const srcRoot = fs.existsSync(path.join(root, 'bridge.js')) ? root : path.join(root, 'src');
  const bridgeSrc = fs.readFileSync(path.join(srcRoot, 'bridge.js'), 'utf8');
  ok(!/userSharesAllowedGuild/.test(bridgeSrc), 'bridge no longer filters inbound DMs by guild membership');
  ok(/recordInteraction\(message\.author\.id, 'dm'\)/.test(bridgeSrc), 'an inbound DM is recorded as an interaction before the webhook');
  ok(/Partials\.Channel/.test(bridgeSrc) && /Partials\.Message/.test(bridgeSrc), 'Channel and Message partials are set so uncached DMs arrive');
  ok(/GatewayIntentBits\.DirectMessages/.test(bridgeSrc) && /GatewayIntentBits\.MessageContent/.test(bridgeSrc), 'DirectMessages and MessageContent intents stay enabled');
  ok(/USER_COOLDOWN_MS/.test(bridgeSrc), 'per-user cooldown is unchanged');

  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
