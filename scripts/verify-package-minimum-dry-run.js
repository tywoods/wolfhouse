'use strict';
const assert = require('node:assert/strict');
const { runLunaGuestBookingDryRun, runBookingPreviewDryRun } = require('./lib/luna-guest-booking-dry-run');
const input = {
 client_slug: 'wolfhouse-somo', check_in: '2026-07-01', check_out: '2026-07-05',
 guest_count: 1, package_code: 'malibu', room_type: 'shared', payment_choice: 'deposit',
 guest_name: 'Offline Guest', phone: '+34000000000',
};
async function main() {
 for (const minimum of [4, 5]) {
  let policyRead = false;
  const pg = { query: async (sql, params) => {
   assert(/^\s*SELECT/i.test(sql), 'dry-run SQL remains read-only');
   if (/FROM wh_pricing_items/.test(sql)) {
    policyRead = true;
    assert.deepEqual(params, ['wolfhouse-somo']);
    return { rows: [{ item_type: 'policy', item_code: 'package_min_nights', active: true, metadata: { minimum_nights: minimum } }] };
   }
   return { rows: [] };
  } };
  const result = await runLunaGuestBookingDryRun({ ...input, quote_config: { package_min_nights: 1 } }, { pg });
  assert(policyRead, 'normal dry-run must read saved policy before planning create');
  assert.equal(result.booking_preview.quote.success, minimum === 4);
  assert.equal(result.availability.date_rule_ok, minimum === 4, 'availability and quote agree on saved minimum');
  assert.equal(result.availability.package_min_nights, minimum);
  if (minimum === 5) {
   assert.equal(result.next_action, 'offer_accommodation_or_change_dates');
   assert(!result.planned_actions.includes('would_create_booking_after_approval'));
   assert.match(result.reply_draft, /5/);
  }
 }
 const { buildWolfhouseBookingCreateCommand } = require('./lib/luna-front-desk-accommodation-booking-create-service');
 const { loadConfig } = require('./lib/wolfhouse-quote-calculator');
 for (const channel of ['manual_staff', 'luna_whatsapp']) {
  for (const flags of [{ dry_run: true }, { preview_only: true }, { confirm: false }]) {
   const result = await buildWolfhouseBookingCreateCommand({
    channel, trustedClientSlug: 'wolfhouse-somo',
    transportBody: { ...input, check_out: '2026-07-08', quote_config: { package_min_nights: 1 }, ...flags },
    quoteConfig: { ...loadConfig(), package_min_nights: 10 },
   });
   assert.equal(result.body.booking_preview.quote.success, false, 'create dry-run preserves trusted raised policy');
   assert.equal(result.body.booking_preview.quote.package_min_nights, 10);
  }
 }
 const unavailable = await runLunaGuestBookingDryRun(input, { pg: { query: async () => { throw Error('synthetic outage'); } } });
 assert.equal(unavailable.booking_preview.quote.success, false);
 const accommodation = runBookingPreviewDryRun({ ...input, package_code: 'package_none' });
 assert.equal(accommodation.quote.success, true, 'omitted config in pure helper keeps JSON seed');
 console.log('PASS dry-run saved policy, boundary, untrusted-config rejection, read-only and seed compatibility');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
