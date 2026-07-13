'use strict';

/**
 * verify-sunset-bot-write-endpoints.js
 *
 * Phase 2 — Sunset Luna WRITE / MONEY bot endpoints (booking + payment link +
 * status + waiver). Staging only, test keys only, tenant-locked to sunset.
 *
 * Asserts (pure/offline — static source + reused validators, no DB/network):
 *   - The four /staff/bot/sunset/{booking-create,payment-link,payment-status,
 *     waiver-link} routes are wired with requireBotAuth + POST-only.
 *   - Handlers FORCE client_slug=SUNSET_CLIENT_SLUG (never trust the body).
 *   - booking-create is gated by BOT_BOOKING_ENABLED and rejects accommodation
 *     fields (room/bed/package/nights) with a clear signal.
 *   - payment-link is gated by STRIPE_LINKS_ENABLED and the reused creator still
 *     blocks live Stripe keys (sk_live_).
 *   - The Sunset booking creator has NO room/bed/accommodation concept.
 *   - A Sunset bot token cannot create a Wolfhouse booking (creator rejects a
 *     non-sunset client_slug with unsupported_client) — tenant-scope proof.
 *   - The Hermes plugin registers the four Phase-2 write tools under the sunset
 *     tenant AND keeps the Wolfhouse tool set unchanged for other tenants.
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('  PASS  ' + msg); }
  else { fail += 1; console.log('  FAIL  ' + msg); }
}

const ROOT = path.resolve(__dirname, '..');
const staffApiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const stripeLibSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'sunset-stripe-payment-links.js'), 'utf8');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);

console.log('\n── A. Phase-2 write routes wired (POST-only + bot auth) ──');
const routes = [
  '/staff/bot/sunset/booking-create',
  '/staff/bot/sunset/payment-link',
  '/staff/bot/sunset/payment-status',
  '/staff/bot/sunset/waiver-link',
];
for (const r of routes) {
  ok(staffApiSrc.includes(`pathname === '${r}'`), `route ${r} registered`);
}
// Each route requires bot auth right before dispatching to its handler.
for (const [r, h] of [
  ['/staff/bot/sunset/booking-create', 'handleBotSunsetBookingCreate'],
  ['/staff/bot/sunset/payment-link', 'handleBotSunsetPaymentLink'],
  ['/staff/bot/sunset/payment-status', 'handleBotSunsetPaymentStatus'],
  ['/staff/bot/sunset/waiver-link', 'handleBotSunsetWaiverLink'],
]) {
  const idx = staffApiSrc.indexOf(`pathname === '${r}'`);
  const block = staffApiSrc.slice(idx, idx + 400);
  ok(/requireBotAuth\(req, res\)/.test(block) && block.includes(h), `route ${r} → requireBotAuth + ${h}`);
}

console.log('\n── B. Handlers force sunset tenant + gated by feature flags ──');
const writeBlock = staffApiSrc.slice(
  staffApiSrc.indexOf('async function handleBotSunsetBookingCreate'),
  staffApiSrc.indexOf('async function handleCustomerList'),
);
const forced = (writeBlock.match(/clientSlug:\s*SUNSET_CLIENT_SLUG|SUNSET_CLIENT_SLUG,/g) || []).length;
ok(forced >= 4, `client_slug forced to SUNSET_CLIENT_SLUG across write handlers (found ${forced})`);
ok(!/body\.client_slug|body\.client\b/.test(writeBlock), 'write handlers never read client_slug/client from body');
ok(/if \(!BOT_BOOKING_ENABLED\)/.test(writeBlock), 'booking-create gated by BOT_BOOKING_ENABLED');
ok(/if \(!STRIPE_LINKS_ENABLED\)/.test(writeBlock), 'payment-link gated by STRIPE_LINKS_ENABLED');
  ok(staffApiSrc.includes('normalizeSunsetBookingDatesInBody'), 'bot booking-create normalizes omitted-year dates');

console.log('\n── C. booking-create rejects accommodation fields ──');
ok(/SUNSET_FORBIDDEN_BOOKING_FIELDS/.test(staffApiSrc), 'accommodation reject list defined');
for (const f of ['room_type', 'bed_code', 'selected_bed_codes', 'package_code', 'check_in', 'check_out', 'nights']) {
  ok(staffApiSrc.includes(`'${f}'`), `forbidden field listed: ${f}`);
}
ok(/accommodation_fields_not_supported/.test(writeBlock), 'booking-create returns accommodation_fields_not_supported');
// The reused validator has no room/bed/accommodation concept.
const writesLibSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-writes.js'), 'utf8');
ok(!/room_type|bed_code|selected_bed_codes|check_out|nights/i.test(
  writesLibSrc.slice(writesLibSrc.indexOf('function validateScheduleBookingBody'),
    writesLibSrc.indexOf('function generateSunsetManualBookingCode'))),
  'Sunset booking validator has no room/bed/accommodation fields');

console.log('\n── D. Money guard: reused creator blocks live Stripe keys ──');
ok(/sk_live_/.test(stripeLibSrc) && /blocked/i.test(stripeLibSrc), 'sunset-stripe-payment-links blocks sk_live_ keys');
ok(/stripeLinksEnabled:\s*STRIPE_LINKS_ENABLED/.test(writeBlock), 'payment-link passes STRIPE_LINKS_ENABLED to creator');
ok(/stripeSecretKey:\s*STRIPE_SECRET_KEY/.test(writeBlock), 'payment-link passes STRIPE_SECRET_KEY (guard runs on it)');
// No hardcoded live-key literal (a real key would be sk_live_ followed by chars);
// the only sk_live_ mention is a comment noting the reused creator blocks it.
ok(!/sk_live_[A-Za-z0-9]/.test(writeBlock), 'no live key literal in the bot handlers');

console.log('\n── E. Tenant scope: sunset creator rejects a Wolfhouse booking ──');
const { createSunsetScheduleBooking } = require('./lib/sunset-schedule-booking-writes');
const { createSunsetScheduleStripeLink } = require('./lib/sunset-stripe-payment-links');
// A fake pg that would throw if a query ran — proves rejection happens BEFORE any DB access.
const explodingPg = { query() { throw new Error('DB must not be touched for a foreign tenant'); } };
(async () => {
  const bkForeign = await createSunsetScheduleBooking(explodingPg, {
    clientSlug: 'wolfhouse-somo',
    body: { guest_name: 'X', components: { lesson: { quantity: 1 } }, service_date: '2026-08-01' },
    locationId: 'sunset-somo',
  });
  ok(bkForeign && bkForeign.ok === false && bkForeign.body && bkForeign.body.error === 'unsupported_client',
    'createSunsetScheduleBooking rejects wolfhouse-somo (unsupported_client)');
  const linkForeign = await createSunsetScheduleStripeLink(explodingPg, {
    clientSlug: 'wolfhouse-somo', bookingCode: 'X', locationId: 'sunset-somo',
    staffActionsEnabled: true, stripeLinksEnabled: true, stripeSecretKey: 'sk_test_x',
    stripeSuccessUrl: 'https://x/s', stripeCancelUrl: 'https://x/c',
  });
  ok(linkForeign && linkForeign.ok === false && linkForeign.body && linkForeign.body.error === 'unsupported_client',
    'createSunsetScheduleStripeLink rejects wolfhouse-somo (unsupported_client)');

  // Live-key block still fires for the sunset tenant.
  const linkLive = await createSunsetScheduleStripeLink(explodingPg, {
    clientSlug: 'sunset', bookingCode: 'X', locationId: 'sunset-somo',
    staffActionsEnabled: true, stripeLinksEnabled: true, stripeSecretKey: 'sk_live_should_block',
    stripeSuccessUrl: 'https://x/s', stripeCancelUrl: 'https://x/c',
  });
  ok(linkLive && linkLive.ok === false && /blocked/i.test(linkLive.body && linkLive.body.error || ''),
    'createSunsetScheduleStripeLink blocks a live key for sunset too');

  console.log('\n── E2. Luna attribution persisted at write time ──');
  const { resolveScheduleBookingAttribution, LUNA_DB_SOURCE } = require('./lib/sunset-schedule-booking-writes');
  const lunaAttr = resolveScheduleBookingAttribution({ source: 'agent_luna_whatsapp_bot' });
  ok(lunaAttr.dbSource === LUNA_DB_SOURCE, 'bot actor resolves to luna_guest db source');

  console.log('\n── E3. Payment link returns compact guest URL ──');
  const { attachGuestPaymentFields, SUNSET_STAGING_PUBLIC_PAYMENT_BASE } = require('./lib/sunset-stripe-payment-links');
  const code = 'SUNSET-20260802-TEST';
  const guestBody = attachGuestPaymentFields({ success: true }, code, 'https://checkout.stripe.com/c/pay/cs_test_x', 'cs_test_x', {});
  ok(guestBody.guest_payment_url && guestBody.guest_payment_url.startsWith(`${SUNSET_STAGING_PUBLIC_PAYMENT_BASE}/pay/`),
    'guest_payment_url is compact /pay/<code>');
  ok(!guestBody.guest_payment_url.includes('checkout.stripe.com'), 'guest URL is not raw Stripe');
  ok(pluginSrc.includes('_guest_payment_url(data)') && pluginSrc.includes('create_sunset_payment_link'),
    'plugin prefers guest_payment_url for secure_payment_url');

  console.log('\n── F. Hermes plugin: Phase-2 write tools under sunset tenant ──');
  for (const t of ['create_sunset_booking', 'create_sunset_payment_link', 'get_sunset_payment_status', 'get_sunset_waiver_link']) {
    ok(pluginSrc.includes(`def ${t}(`), `plugin defines handler ${t}`);
    ok(pluginSrc.includes(`"${t}"`), `plugin registers tool name ${t}`);
  }
  ok(/tools = _sunset_tools\(\) \+ _sunset_write_tools\(\)/.test(pluginSrc),
    'register() adds _sunset_write_tools() under the sunset tenant');
  // Write tools hit the Phase-2 routes.
  const writeToolsBlock = pluginSrc.slice(
    pluginSrc.indexOf('def create_sunset_booking'),
    pluginSrc.indexOf('def _is_sunset_tenant'),
  );
  ok(writeToolsBlock.includes('/sunset/booking-create')
    && writeToolsBlock.includes('/sunset/payment-link')
    && writeToolsBlock.includes('/sunset/payment-status')
    && writeToolsBlock.includes('/sunset/waiver-link'),
    'write tools call the Phase-2 /sunset/* routes');
  // Wolfhouse tools remain present + unchanged (registered when NOT sunset tenant).
  for (const t of ['create_booking_from_plan', 'check_availability', 'quote_booking']) {
    ok(pluginSrc.includes(`def ${t}(`), `Wolfhouse tool ${t} still present`);
  }

  console.log('\n────────────────────────────────────────────────');
  console.log(`verify:sunset-bot-write-endpoints  pass=${pass}  fail=${fail}`);
  if (fail > 0) { process.exit(1); }
  console.log('verify:sunset-bot-write-endpoints — ALL CHECKS PASSED');
})();
