'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'scripts/lib/staff-bot-v2-routes.js'), 'utf8');
const bookingGuests = fs.readFileSync(path.join(root, 'scripts/lib/booking-guests.js'), 'utf8');
const modeRoutes = fs.readFileSync(path.join(root, 'scripts/lib/staff-inbox-luna-mode-routes.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'scripts/browser/inbox-shell.js'), 'utf8');
const paymentService = fs.readFileSync(path.join(root, 'scripts/lib/luna-front-desk-payment-link-service.js'), 'utf8');
const plugin = fs.readFileSync(path.join(root, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
const modeStore = require(path.join(root, 'scripts/lib/email-inbox-channel-mode.js'));
const { assertTrustedGuestOwnsTarget } = require(path.join(root, 'scripts/lib/per-guest-checkout.js'));
const { gateBotPaymentUuidCallbackTenantAcl } = require(path.join(root, 'scripts/lib/payment-uuid-callback-tenant-acl.js'));

function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start) + start.length));
}

(async () => {
  const prefs = section(api, 'async function handleAuthPrefs', '// ─────────────────────────────────────────────────────────────────────────────\nasync function handleAuthMe');
  assert.match(prefs, /hasModesKey[\s\S]*hasRole\(auth\.user\.role, 'operator'\)/);
  assert.match(prefs, /withPgClient\(async \(pgClient\)[\s\S]*query\('BEGIN'\)[\s\S]*saveClientInboxChannelModes\([^)]*pgClient\)[\s\S]*UPDATE staff_users[\s\S]*query\('COMMIT'\)[\s\S]*query\('ROLLBACK'\)/);
  for (const name of ['handleBotPausePost', 'handleBotResumePost', 'handleBotGlobalPausePost', 'handleBotGlobalResumePost']) {
    const body = section(api, `async function ${name}`, '\n}\n');
    assert.doesNotMatch(body, /BOT_PAUSE_CONTROLS_ENABLED/);
    assert.match(body, /assertStaffMutationClientAccess\(user, clientSlug, res\)/);
  }
  assert.doesNotMatch(section(routes, 'function evaluateBotBookingCapability', '\n}'), /BOT_BOOKING_ENABLED/);
  assert.doesNotMatch(routes, /bot_booking_disabled/);
  assert.match(routes, /makeInMemoryBotReq\(\{[\s\S]*payment_target: paymentTarget,[\s\S]*\}, req\.headers, ctx\.boundClientSlug\)/);
  assert.match(routes, /await pg\.query\('BEGIN'\)[\s\S]*resolveAutomaticBookingAdmission[\s\S]*await pg\.query\('COMMIT'\)/);
  assert.match(routes, /const insResult = await withPgClient[\s\S]*resolveAutomaticBookingAdmission\(pg[\s\S]*INSERT INTO payments[\s\S]*await pg\.query\('COMMIT'\)/);
  assert.match(routes, /Final revocation check immediately before the authoritative payment owner[\s\S]*requirePortalAutomaticWriteAdmission[\s\S]*createPaymentLink/);
  assert.match(routes, /authorizeAutomaticWrite: authMode === 'bot_token' && ctx\.boundClientSlug === 'wolfhouse-somo'/);
  assert.match(paymentService, /b\.phone AS booking_phone[\s\S]*trustedGuestPhone[\s\S]*payment_target_guest_mismatch/);
  assert.match(paymentService, /authorizeAutomaticWrite[\s\S]*BEGIN[\s\S]*automatic_admission_receipt[\s\S]*COMMIT[\s\S]*createSession/);
  assert.match(paymentService, /booking_guest_id[\s\S]*guest_metadata[\s\S]*ownerPhones[\s\S]*payment_target_guest_mismatch/);
  assert.match(shell, /var busy = wrap\.classList\.contains\('is-busy'\)[\s\S]*btns\[i\]\.disabled = busy \|\| \(mode === 'auto' && paused\)/);
  assert.match(api, /const rawSaved = row\.inbox_channel_modes[\s\S]*hasOwnProperty\.call\(rawSaved, channel\)[\s\S]*channel_mode_unproven/);
  assert.match(plugin, /\(503, "booking_policy_unavailable", "portal_policy_lookup"\)/);
  assert.match(plugin, /"policy_source": data\.get\("policy_source"\)/);
  assert.match(plugin, /bool\(link_result\.get\("do_not_escalate"\)\)/);
  assert.match(api, /body = \{ \.\.\.body, phone: trustedGuestPhone, guest_phone: trustedGuestPhone \}/);
  assert.match(api, /booking_identity_mismatch/);
  assert.match(paymentService, /b\.phone AS booking_phone[\s\S]*trustedGuestPhone[\s\S]*payment_target_guest_mismatch/);
  assert.match(bookingGuests, /booking_channel_off/);
  assert.match(bookingGuests, /booking_policy_unavailable/);
  assert.match(modeRoutes, /invalid_mode/);

  const writes = [];
  let stored = {};
  let failQuery = false;
  const store = modeStore.createEmailInboxChannelModeStore({
    withPgClient: async (fn) => fn({ query: async (sql, params) => {
      if (failQuery) throw new Error('settings unavailable');
      if (/^SELECT /.test(sql)) {
        return { rows: [{ inbox_channel_modes: stored }] };
      }
      stored = { ...stored, [params[2]]: params[1] }; writes.push({ ...stored }); return { rows: [{ inbox_channel_modes: stored }] };
    } }),
  });
  await assert.rejects(() => store.putChannelMode('tenant', 'whatsapp', 'bogus'), /channel_mode_unproven/);
  await store.putChannelMode('tenant', 'email', 'off');
  assert.equal(Object.hasOwn(writes.at(-1), 'whatsapp'), false);
  stored = { whatsapp: 'off' };
  await store.putChannelMode('tenant', 'email', 'draft');
  assert.equal(writes.at(-1).whatsapp, 'off');
  failQuery = true;
  await assert.rejects(() => store.putChannelMode('tenant', 'email', 'off'), /channel_mode_unproven/);

  assert.throws(() => assertTrustedGuestOwnsTarget({ booking_phone: '+34 611 22 33 44', guest_metadata: {} }, '34611223344'), /payment_target_guest_mismatch/);
  assert.doesNotThrow(() => assertTrustedGuestOwnsTarget({ booking_phone: '+34 600 00 00 00', guest_metadata: { phone: '+34 611 22 33 44' } }, '34611223344'));
  assert.throws(() => assertTrustedGuestOwnsTarget({ booking_phone: '+34 611 22 33 44', guest_metadata: { phone: '+34 600 00 00 00' } }, '34611223344'), /payment_target_guest_mismatch/);
  const gate = (trustedGuestPhone) => gateBotPaymentUuidCallbackTenantAcl({
    paymentId: '00000000-0000-4000-8000-000000000001', boundClientSlug: 'wolfhouse-somo', trustedGuestPhone,
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [{ client_slug: 'wolfhouse-somo', booking_phone: '+34 611 22 33 44' }] }) }),
  });
  assert.equal((await gate('34611223344')).ok, true);
  assert.equal((await gate('34600000000')).reason, 'payment_target_guest_mismatch');
  console.log('verify-sim8-captain-changes PASS');
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
