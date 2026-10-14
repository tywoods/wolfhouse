'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'scripts/lib/staff-bot-v2-routes.js'), 'utf8');
const bookingGuests = fs.readFileSync(path.join(root, 'scripts/lib/booking-guests.js'), 'utf8');
const modeRoutes = fs.readFileSync(path.join(root, 'scripts/lib/staff-inbox-luna-mode-routes.js'), 'utf8');
const modeStore = require(path.join(root, 'scripts/lib/email-inbox-channel-mode.js'));

function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
}

(async () => {
  const prefs = section(api, 'async function handleAuthPrefs', '// ─────────────────────────────────────────────────────────────────────────────\nasync function handleAuthMe');
  assert.match(prefs, /hasModesKey[\s\S]*hasRole\(auth\.user\.role, 'operator'\)/);
  for (const name of ['handleBotPausePost', 'handleBotResumePost', 'handleBotGlobalPausePost', 'handleBotGlobalResumePost']) {
    const body = section(api, `async function ${name}`, '\n}\n');
    assert.doesNotMatch(body, /BOT_PAUSE_CONTROLS_ENABLED/);
    assert.match(body, /assertStaffMutationClientAccess\(user, clientSlug, res\)/);
  }
  assert.doesNotMatch(section(routes, 'function evaluateBotBookingCapability', '\n}'), /BOT_BOOKING_ENABLED/);
  assert.doesNotMatch(routes, /bot_booking_disabled/);
  assert.match(routes, /makeInMemoryBotReq\(\{[\s\S]*payment_target: paymentTarget,[\s\S]*\}, req\.headers\)/);
  assert.match(api, /body = \{ \.\.\.body, phone: trustedGuestPhone, guest_phone: trustedGuestPhone \}/);
  assert.match(api, /booking_identity_mismatch/);
  assert.match(bookingGuests, /booking_channel_off/);
  assert.match(bookingGuests, /booking_policy_unavailable/);
  assert.match(modeRoutes, /invalid_mode/);

  const writes = [];
  let stored = {};
  let failLoad = false;
  const store = modeStore.createEmailInboxChannelModeStore({
    withPgClient: async (fn) => fn({ query: async (sql, params) => {
      if (/^SELECT /.test(sql)) {
        if (failLoad) throw new Error('settings unavailable');
        return { rows: [{ inbox_channel_modes: stored }] };
      }
      stored = JSON.parse(params[1]); writes.push(stored); return { rows: [{ inbox_channel_modes: stored }] };
    } }),
  });
  await assert.rejects(() => store.putChannelMode('tenant', 'whatsapp', 'bogus'), /channel_mode_unproven/);
  await store.putChannelMode('tenant', 'email', 'off');
  assert.equal(Object.hasOwn(writes.at(-1), 'whatsapp'), false);
  stored = { whatsapp: 'off' };
  await store.putChannelMode('tenant', 'email', 'draft');
  assert.equal(writes.at(-1).whatsapp, 'off');
  failLoad = true;
  await assert.rejects(() => store.putChannelMode('tenant', 'email', 'off'), /channel_mode_unproven/);
  console.log('verify-sim8-captain-changes PASS');
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
