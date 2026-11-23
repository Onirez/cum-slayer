#!/usr/bin/env node
'use strict';
// Manual test hook for the daily roast.
//   node roast_now.js --dry-run [user_id]   -> print the payload, post nothing
//   node roast_now.js [user_id]             -> fire the routine webhook now (real roast)
// Does not touch the daily schedule (done-date); records the roast in history.
const roast = require('./roast');
(async () => {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const uid = args.find((a) => /^\d{5,25}$/.test(a)) || null;
  await roast.seedContacts();
  const payload = await roast.buildRoastPayload({ forcedId: uid });
  if (!payload) { console.error('no eligible target (contacts empty, or user not a human guild member)'); process.exit(1); }
  if (dry) {
    console.log(JSON.stringify(payload, null, 2));
    console.log(`dry-run: would POST the routine webhook (bytes=${JSON.stringify(payload).length}) — nothing sent`);
    return;
  }
  const res = await roast.postWebhook(payload);
  console.log(`webhook POST status=${res.status} body=${res.body}`);
  if (res.ok) roast.recordRoast({ date: new Date().toISOString().slice(0, 10), user_id: payload.target.id, channel_id: payload.channel_id, at: Date.now(), manual: true });
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
