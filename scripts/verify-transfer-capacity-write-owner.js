'use strict';

// Authentic shared-owner/handler/SQL regression for authoritative transfer capacity.
const assert = require('node:assert/strict');
const { createHarness } = require('./verify-transfer-admin-price-custom');
const { execDelegatedTransferWrite } = require('./lib/staff-bot-v2-routes');

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
    const count = async (bookingId = h.bookingId) => Number((await h.db.query(
      'SELECT COUNT(*)::int AS n FROM booking_transfers WHERE booking_id=$1', [bookingId])).rows[0].n);

    // Bot delegates without UI-only options: the shared owner must still load authority.
    const botDenied = await execDelegatedTransferWrite(h.bookingId, {
      client_slug: WH, direction: 'arrival', airport_code: 'SDR', guest_count: 4, source: 'luna',
    }, h.routes.handlePostBookingTransfer);
    assert.equal(botDenied.statusCode, 400);
    assert.equal(botDenied.error, 'transfer_guest_count_above_maximum');
    assert.equal(botDenied.write_performed, false);
    assert.equal(await count(), 0, 'bot rejection must make zero writes');

    const uiDenied = await h.dispatch('POST', { guest_count: 4 });
    assert.equal(uiDenied.status, 400);
    assert.equal(uiDenied.body.reason_code, 'transfer_guest_count_above_maximum');
    assert.equal(uiDenied.body.write_performed, false);
    assert.equal(await count(), 0, 'UI rejection must make zero writes');

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
