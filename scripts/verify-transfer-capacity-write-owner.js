'use strict';

// Authentic shared-owner/handler/SQL regression for authoritative transfer capacity.
const assert = require('node:assert/strict');
const { createHarness } = require('./verify-transfer-admin-price-custom');
const { execDelegatedTransferWrite, handleBotTransferSave } = require('./lib/staff-bot-v2-routes');

const WH = 'wolfhouse-somo';

function response() {
  return { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

async function run() {
  const h = await createHarness();
  try {
    await h.db.query(`INSERT INTO wh_pricing_transfer_rules
      (client_slug,airport_code,label,requires_package,included_when_package,max_guest_count,active)
      VALUES ($1,'SDR','Santander',false,true,3,true)
      ON CONFLICT (client_slug,airport_code) WHERE active=true
      DO UPDATE SET max_guest_count=EXCLUDED.max_guest_count`, [WH]);
    await h.db.query(`INSERT INTO wh_pricing_transfer_rules
      (client_slug,airport_code,label,requires_package,included_when_package,min_guest_count,max_guest_count,active)
      VALUES ($1,'BIO','Bilbao',false,false,4,8,true)`, [WH]);
    await h.db.query("UPDATE bookings SET package_code='package_surf' WHERE id=$1", [h.bookingId]);
    const { loadStaffTransferConfig } = require('./lib/staff-transfer-pricing');
    const pricing = await loadStaffTransferConfig(h.pg, WH);
    const sdrRule = pricing.rules.find((r) => r.airport_code === 'SDR');
    const bioRule = pricing.rules.find((r) => r.airport_code === 'BIO');
    assert.equal(sdrRule.source, 'db');
    assert.equal(sdrRule.included_when_package, true,
      'SDR inclusion must come from authoritative Staff Pricing');
    assert.equal(bioRule.source, 'db');
    assert.equal(bioRule.included_when_package, false);
    assert.equal(bioRule.min_guest_count, 4);
    const count = async (bookingId = h.bookingId) => Number((await h.db.query(
      'SELECT COUNT(*)::int AS n FROM booking_transfers WHERE booking_id=$1', [bookingId])).rows[0].n);

    // Bot delegates without UI-only options: the shared owner must still load authority.
    let delegatedOptions = null;
    const authoritativeOwner = (...args) => {
      delegatedOptions = args[3];
      return h.routes.handlePostBookingTransfer(...args);
    };
    const botDenied = await execDelegatedTransferWrite(h.bookingId, {
      client_slug: WH, direction: 'arrival', airport_code: 'SDR', guest_count: 4, source: 'luna',
    }, authoritativeOwner);
    assert.deepEqual(delegatedOptions, { resolveAdminPricing: true },
      'ordinary bot writes must explicitly request authoritative DB pricing');
    assert.equal(botDenied.statusCode, 400);
    assert.equal(botDenied.error, 'transfer_guest_count_above_maximum');
    assert.equal(botDenied.reason_code, 'transfer_guest_count_above_maximum');
    assert.equal(botDenied.guest_count, 4);
    assert.equal(botDenied.max_guest_count, 3);
    assert.match(botDenied.guest_message, /at most 3 guests/);
    assert.equal(botDenied.write_performed, false);
    assert.equal(await count(), 0, 'bot rejection must make zero writes');

    // The final Staff bot HTTP owner must preserve the refusal tuple consumed by
    // the staging plugin; testing the delegated helper alone misses route loss.
    const routeRes = {};
    await handleBotTransferSave({}, routeRes, null, 'bot', {
      sendJSON: (res, status, body) => Object.assign(res, { status, body }),
      send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
      readBody: async () => JSON.stringify({
        booking_id: h.bookingId, client_slug: WH, direction: 'arrival',
        airport_code: 'SDR', guest_count: 4, source: 'luna', confirm_transfer_write: true,
        scheduled_at: '2027-07-19T12:30:00Z', flight_number: 'IB1567',
      }),
      withPgClient: async (fn) => fn(h.db),
      handlePostBookingTransfer: h.routes.handlePostBookingTransfer,
      DEFAULT_CLIENT: WH, STAFF_AUTH_REQUIRED: true, boundClientSlug: WH,
    });
    assert.equal(routeRes.status, 400);
    assert.equal(routeRes.body.success, false);
    assert.equal(routeRes.body.write_performed, false);
    assert.equal(routeRes.body.reason_code, 'transfer_guest_count_above_maximum');
    assert.equal(routeRes.body.guest_count, 4);
    assert.equal(routeRes.body.max_guest_count, 3);
    assert.match(routeRes.body.guest_message, /at most 3 guests/);
    assert.equal(await count(), 0, 'final bot route rejection must make zero writes');

    for (const incomplete of [
      { flight_number: 'IB1567' },
      { scheduled_at: '2027-07-19T12:30:00Z' },
    ]) {
      const pending = {};
      await handleBotTransferSave({}, pending, null, 'bot', {
        sendJSON: (res, status, body) => Object.assign(res, { status, body }),
        send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
        readBody: async () => JSON.stringify({ booking_id: h.bookingId, client_slug: WH,
          direction: 'arrival', airport_code: 'SDR', guest_count: 3, source: 'luna',
          confirm_transfer_write: true, ...incomplete }),
        withPgClient: async (fn) => fn(h.db), handlePostBookingTransfer: h.routes.handlePostBookingTransfer,
        DEFAULT_CLIENT: WH, STAFF_AUTH_REQUIRED: true, boundClientSlug: WH,
      });
      assert.equal(pending.status, 200);
      assert.equal(pending.body.write_performed, false);
      assert.equal(pending.body.transfer_not_booked_yet, true);
      assert.equal(pending.body.staff_will_confirm, true);
      assert.equal(pending.body.next_action, 'ask_missing_transfer_details');
      assert.match(pending.body.reply_draft, /not booked yet/i);
      assert.equal(await count(), 0, 'incomplete transfer must remain pending');
    }

    await h.db.query("UPDATE wh_pricing_transfer_rules SET max_guest_count=3 WHERE client_slug=$1 AND airport_code='SDR'", [WH]);
    const savedRoute = {};
    await handleBotTransferSave({}, savedRoute, null, 'bot', {
      sendJSON: (res, status, body) => Object.assign(res, { status, body }),
      send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
      readBody: async () => JSON.stringify({ booking_id: h.bookingId, client_slug: WH,
        direction: 'arrival', airport_code: 'SDR', guest_count: 3, source: 'luna',
        confirm_transfer_write: true, scheduled_at: '2027-07-19T12:30:00Z', flight_number: 'IB1567' }),
      withPgClient: async (fn) => fn(h.db), handlePostBookingTransfer: h.routes.handlePostBookingTransfer,
      DEFAULT_CLIENT: WH, STAFF_AUTH_REQUIRED: true, boundClientSlug: WH,
    });
    assert.equal(savedRoute.status, 200, JSON.stringify(savedRoute.body));
    assert.equal(savedRoute.body.success, true);
    assert.equal(savedRoute.body.write_performed, true);
    const staffReadback = await h.dispatch('GET');
    assert.equal(staffReadback.status, 200);
    assert.equal(staffReadback.body.transfers.length, 1);
    assert.equal(staffReadback.body.transfers[0].airport_code, 'SDR');
    assert.equal(staffReadback.body.transfers[0].flight_number, 'IB1567');
    await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1', [h.bookingId]);

    const uiDenied = await h.dispatch('POST', { guest_count: 4 });
    assert.equal(uiDenied.status, 400);
    assert.equal(uiDenied.body.reason_code, 'transfer_guest_count_above_maximum');
    assert.equal(uiDenied.body.write_performed, false);
    assert.equal(await count(), 0, 'UI rejection must make zero writes');

    for (const guestCount of ['banana', true, [2], 0, -1, 1.5]) {
      const invalid = await h.dispatch('POST', { guest_count: guestCount });
      assert.equal(invalid.status, 400, `invalid guest_count ${guestCount}`);
      assert.equal(invalid.body.reason_code, 'transfer_guest_count_invalid');
      assert.equal(invalid.body.write_performed, false);
      assert.equal(await count(), 0, `invalid guest_count ${guestCount} must make zero writes`);
    }

    const accepted = await h.dispatch('POST', { guest_count: 3 });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.write_performed, true);
    assert.equal(await count(), 1);
    await h.db.query('DELETE FROM booking_transfers WHERE booking_id=$1', [h.bookingId]);

    // A direct shared-owner caller cannot bypass authority by omitting route options.
    const direct = response();
    await h.routes.handlePostBookingTransfer(h.bookingId, h.request({
      client_slug: WH, direction: 'arrival', airport_code: 'SDR', guest_count: 4, source: 'staff',
    }), direct);
    assert.equal(direct.code, 400);
    assert.equal(direct.body.reason_code, 'transfer_guest_count_above_maximum');
    assert.equal(await count(), 0);

    // Null/missing capacity is ambiguous and therefore fails closed.
    await h.db.query("UPDATE wh_pricing_transfer_rules SET max_guest_count=NULL WHERE client_slug=$1 AND airport_code='SDR'", [WH]);
    const missing = await h.dispatch('POST', { guest_count: 1 });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.reason_code, 'transfer_capacity_config_missing');
    assert.equal(missing.body.write_performed, false);
    assert.equal(await count(), 0);

    // Airport and tenant scope are part of authority; neither may borrow SDR's max.
    await h.db.query("UPDATE wh_pricing_transfer_rules SET max_guest_count=3 WHERE client_slug=$1 AND airport_code='SDR'", [WH]);
    const wrongLocation = await h.dispatch('POST', { airport_code: 'XXX', guest_count: 1 });
    assert.equal(wrongLocation.status, 409);
    assert.equal(wrongLocation.body.reason_code, 'transfer_capacity_config_missing');
    assert.equal(await count(), 0);
    const sunsetId = (await h.db.query("SELECT b.id::text AS id FROM bookings b JOIN clients c ON c.id=b.client_id WHERE c.slug='sunset' LIMIT 1")).rows[0].id;
    const sunset = await h.dispatch('POST', { airport_code: 'SDR', guest_count: 1 }, 'sunset', sunsetId);
    assert.equal(sunset.status, 409);
    assert.equal(sunset.body.reason_code, 'transfer_capacity_config_missing');
    assert.equal(await count(), 0);

    console.log('PASS: UI, bot, and direct writes share tenant/location-scoped authoritative capacity; failures make zero writes.');
  } finally {
    await h.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
