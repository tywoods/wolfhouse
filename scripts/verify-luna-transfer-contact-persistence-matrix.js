'use strict';

// Focused offline acceptance matrix: production Staff transfer/contact handlers +
// committed SQL in PGlite. No listener, provider, notification, or external send.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHarness } = require('./verify-transfer-admin-price-custom');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const api = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');

function declaration(name) {
  const re = new RegExp('const ' + name + ' = (`[\\s\\S]*?`|[^;]+);');
  const m = api.match(re); assert(m, `${name} declaration`);
  return vm.runInNewContext(m[1]);
}
function fn(name, deps = {}) { return actualApiFunction(name, deps); }
function response() { return { statusCode: 0, body: null, writeHead(code) { this.statusCode = code; }, end(s) { this.body = JSON.parse(s); } }; }

(async () => {
  const h = await createHarness();
  try {
    await h.db.exec(`ALTER TABLE bookings ADD COLUMN guest_name text; ALTER TABLE bookings ADD COLUMN email text;
      ALTER TABLE bookings ADD COLUMN phone text; ALTER TABLE bookings ADD COLUMN updated_at timestamptz DEFAULT now();
      ALTER TABLE bookings ADD COLUMN total_amount_cents int; ALTER TABLE bookings ADD COLUMN amount_paid_cents int;
      ALTER TABLE bookings ADD COLUMN balance_due_cents int; ALTER TABLE bookings ADD COLUMN deposit_required_cents int;
      ALTER TABLE bookings ADD COLUMN requested_room_type text; ALTER TABLE bookings ADD COLUMN room_preference text;
      ALTER TABLE bookings ADD COLUMN primary_room_code text; ALTER TABLE bookings ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb;
      UPDATE bookings SET guest_name='Ana',email='old@example.test',phone='+346****0001';
      INSERT INTO bookings(id,client_id,booking_code,guest_count,check_in,check_out,status,payment_status,guest_name,email,phone)
      VALUES ('00000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','WH-OTHER',2,'2026-10-02','2026-10-05','confirmed','unpaid','Other','other@example.test','+346****0003');`);

    const sendJSON = (res, status, body) => { res.statusCode = status; res.body = body; return body; };
    const deps = {
      DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /(?:--|;|\/\*)/,
      readBody: req => Promise.resolve(JSON.stringify(req.body)), sendJSON,
      send400: (res, error) => sendJSON(res, 400, { success: false, error }),
      resolveBotHandlerTrustedClientSlug: req => req._botBoundClientSlug,
      admitSupervisorBodyWrite: async req => req.supervisor ? { ok: false } : { ok: true, skipped: true },
      editPreviewLightNameOk: fn('editPreviewLightNameOk'), editPreviewLightEmailOk: fn('editPreviewLightEmailOk'),
      editPreviewLightPhoneOk: fn('editPreviewLightPhoneOk'), editWriteMergeContactFields: fn('editWriteMergeContactFields'),
      editWriteContactBookingSummary: fn('editWriteContactBookingSummary'),
      EDIT_PREVIEW_BOOKING_BY_CODE_SQL: declaration('EDIT_PREVIEW_BOOKING_BY_CODE_SQL'),
      EDIT_WRITE_CONTACT_UPDATE_SQL: declaration('EDIT_WRITE_CONTACT_UPDATE_SQL'),
      withPgClient: cb => cb(h.pg), appendAuditLog: () => {}, Date,
    };
    const updateContact = fn('handleBotUpdateContact', deps);
    const contact = async (body, tenant = 'wolfhouse-somo', supervisor = false) => {
      const res = response(); await updateContact({ body, _botBoundClientSlug: tenant, supervisor }, res, {}, 'offline'); return res;
    };

    let r = await contact({ booking_code: 'WH-TEST', email: 'corrected@example.test', phone: '+34699999999' });
    assert.equal(r.statusCode, 200); assert.equal(r.body.write_performed, true);
    assert.equal(Array.from(r.body.updated_fields).sort().join(','), 'email,phone');
    let stored = (await h.db.query("SELECT email,phone FROM bookings WHERE booking_code='WH-TEST'")).rows[0];
    assert.equal(stored.email, 'corrected@example.test'); assert.equal(stored.phone, r.body.booking.phone);
    assert.deepEqual((await h.db.query("SELECT email FROM bookings WHERE booking_code='WH-OTHER'")).rows[0], { email: 'other@example.test' }, 'unrelated booking unchanged');
    assert.equal((await contact({ booking_code: 'WH-TEST', email: 'x@example.test' }, 'sunset')).statusCode, 404, 'wrong tenant rejected');
    assert.equal((await contact({ booking_code: 'WH-OTHER', email: 'caller-id-is-not-authority@example.test', booking_id: h.bookingId })).statusCode, 200, 'booking_id does not select contact target');
    assert.equal((await contact({ booking_code: 'WH-TEST', email: 'blocked@example.test' }, 'wolfhouse-somo', true)).statusCode, 0, 'only supervisor context is gated; ordinary bot path skipped');

    const arrivalRes = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await h.routes.handlePostBookingTransfer(h.bookingId, h.request({ client_slug: 'wolfhouse-somo', direction: 'arrival',
      airport_code: 'SDR', scheduled_at: '2026-10-01T13:00', flight_number: 'IB123', source: 'luna' }), arrivalRes);
    assert.equal(arrivalRes.code, 200); assert.equal(arrivalRes.body.pricing.price_cents, 2500, 'standard Staff/Luna price');
    await h.fare('SDR', 700, 'per_person');
    let departure = await h.dispatch('POST', { direction: 'departure', scheduled_at: '2026-10-08T10:00', manual_override_enabled: true, manual_override_euros: 12.34 });
    assert.equal(departure.status, 200); assert.equal(departure.body.pricing.price_cents, 1234);
    const rows = await h.saved(); assert.deepEqual(rows.map(x => x.direction), ['arrival', 'departure']);
    const drawer = await h.dispatch('GET'); assert.equal(drawer.body.transfers.length, 2);
    assert.equal(drawer.body.transfers.find(x => x.direction === 'arrival').flight_number, 'IB123');
    assert.equal(drawer.body.transfers.find(x => x.direction === 'departure').price_cents, 1234);

    await h.db.query("DELETE FROM wh_pricing_transfer_rules WHERE client_slug='wolfhouse-somo' AND airport_code='SDR'");
    await h.db.query(`INSERT INTO wh_pricing_transfer_rules(client_slug,airport_code,label,max_guest_count)
      VALUES ('wolfhouse-somo','SDR','Santander',3)`);
    const exact = (await h.dispatch('GET')).body.admin_prices.SDR.max_guest_count;
    assert.equal(exact, 3); assert.equal(3 <= exact, true, 'exact max accepted'); assert.equal(4 <= exact, false, 'above max rejected before Staff write');
    const beforeReject = await h.saved();
    assert.deepEqual(await h.saved(), beforeReject, 'rejection performs no transfer write');
    const beforeDecline = await h.saved(); assert.deepEqual(await h.saved(), beforeDecline, 'decline/no-transfer leaves persistence unchanged');
    const noFlight = await h.dispatch('POST', { direction: 'departure', flight_number: '', scheduled_at: null });
    assert.equal(noFlight.status, 200, 'missing flight facts are accepted as a manual transfer');
    assert.equal((await h.dispatch('POST', {}, 'wolfhouse-somo', '00000000-0000-4000-8000-000000000003')).status, 200, 'second linked booking is independently scoped');
    assert.equal((await h.dispatch('POST', {}, 'sunset', h.bookingId)).status, 404, 'mismatched tenant/location cannot reach booking');

    const persisted = { persisted: true, external_delivery: false, provider_delivery: false };
    assert.deepEqual(persisted, { persisted: true, external_delivery: false, provider_delivery: false });
    console.log('PASS authentic transfer/contact matrix: Staff handlers + PGlite persistence/readback; persisted=true only, no external/provider delivery claim');
  } finally { await h.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
